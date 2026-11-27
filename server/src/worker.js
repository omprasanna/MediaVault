require('dotenv/config');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Worker } = require('bullmq');
const { connectDB, disconnectDB } = require('./config/db');
const Batch = require('./models/Batch');
const Job = require('./models/Job');
const mediaQueue = require('./queues/mediaQueue');
const {
  JOB_CONTROL_CHANNEL,
  MEDIA_QUEUE_NAME,
  createRedisConnection,
} = mediaQueue;
const { AppError } = require('./utils/errors');
const { updateBatchRollup } = require('./utils/batchRollup');
const { sanitizeFilename } = require('./utils/formatMapper');
const { resolvePublicUrl } = require('./utils/ssrf');
const {
  buildProxyChildEnv,
  createPinnedSsrfProxy,
  redactProxyCredentials,
} = require('./utils/ssrfProxy');
const {
  assertSufficientDiskSpace,
  buildYtDlpJobArgs,
  detectMuxingPhase,
  moveToUniquePath,
  parseDownloadTtlMinutes,
  parseHumanSizeToBytes,
  parseYtDlpProgressLine,
  sanitizeFolderName,
} = require('./utils/workerHelpers');
const { prepareCookieArg, validateMediaUrl } = require('./utils/ytdlp');

const WORKER_CONCURRENCY = Math.min(
  2,
  Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2))
);
const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR || '/data/downloads');
const TMP_DOWNLOADS_DIR = path.join(DOWNLOADS_DIR, '.mediavault-tmp');
const DOWNLOAD_TTL_MINUTES = parseDownloadTtlMinutes(process.env.DOWNLOAD_TTL_MINUTES);
const DOWNLOAD_TTL_MS = DOWNLOAD_TTL_MINUTES * 60 * 1000;
const ORPHAN_TMP_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MINUTES || 5) * 60 * 1000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const STALL_TIMEOUT_MS = 90 * 1000;

const activeJobControllers = new Map();
let isCleanupRunning = false;
let cleanupTimer = null;
let workerInstance = null;
let workerConnection = null;
let controlSubscriber = null;

function isSafeDownloadPath(filePath, downloadsDir = DOWNLOADS_DIR) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolvedDir = path.resolve(downloadsDir);
  const resolved = path.resolve(filePath);
  return resolved.startsWith(`${resolvedDir}${path.sep}`);
}

async function unlinkIfSafe(filePath, downloadsDir = DOWNLOADS_DIR) {
  if (!isSafeDownloadPath(filePath, downloadsDir)) return false;
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return true;
    }
    console.error(`Failed to unlink ${filePath}:`, err.message);
    return false;
  }
}

async function removeEmptyPlaylistDirIfSafe(filePath, downloadsDir = DOWNLOADS_DIR) {
  if (!isSafeDownloadPath(filePath, downloadsDir)) return;
  const resolvedDir = path.resolve(downloadsDir);
  const parentDir = path.dirname(path.resolve(filePath));
  if (
    parentDir !== resolvedDir &&
    parentDir.startsWith(`${resolvedDir}${path.sep}`) &&
    path.basename(parentDir) !== '.mediavault-tmp'
  ) {
    await fs.promises.rmdir(parentDir).catch(() => {});
  }
}

async function collectExpiredCandidateFiles(downloadsDir, nowMs, downloadTtlMs) {
  const expiredFiles = [];
  const entries = await fs.promises.readdir(downloadsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.gitkeep' || entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(downloadsDir, entry.name);
    if (entry.isFile()) {
      try {
        const stats = await fs.promises.stat(fullPath);
        if (stats.isFile() && nowMs - stats.mtimeMs > downloadTtlMs) {
          expiredFiles.push(fullPath);
        }
      } catch {
        // Ignore transient stat errors
      }
    } else if (entry.isDirectory()) {
      try {
        const subEntries = await fs.promises.readdir(fullPath, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (!subEntry.isFile() || subEntry.name.startsWith('.')) {
            continue;
          }
          const subPath = path.join(fullPath, subEntry.name);
          try {
            const stats = await fs.promises.stat(subPath);
            if (stats.isFile() && nowMs - stats.mtimeMs > downloadTtlMs) {
              expiredFiles.push(subPath);
            }
          } catch {
            // Ignore transient stat errors
          }
        }
      } catch {
        // Ignore transient directory errors
      }
    }
  }
  return expiredFiles;
}

async function cleanupPartialFiles(jobId, downloadsDir = DOWNLOADS_DIR) {
  const tmpDir = path.join(path.resolve(downloadsDir), '.mediavault-tmp');
  try {
    const entries = await fs.promises.readdir(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith(`${jobId}.`)) {
        await unlinkIfSafe(path.join(tmpDir, entry), downloadsDir);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed cleaning partial files for job ${jobId}:`, err.message);
    }
  }
}

async function findJobOutputFile(jobId, preferredContainer, downloadsDir = DOWNLOADS_DIR) {
  const tmpDir = path.join(path.resolve(downloadsDir), '.mediavault-tmp');
  const preferredPath = path.join(tmpDir, `${jobId}.${preferredContainer}`);
  try {
    const stats = await fs.promises.stat(preferredPath);
    if (stats.isFile()) {
      return preferredPath;
    }
  } catch {
    // Fall back to scanning prefix in case yt-dlp resolved a different extension.
  }

  const entries = await fs.promises.readdir(tmpDir);
  for (const entry of entries) {
    if (
      entry.startsWith(`${jobId}.`) &&
      !entry.endsWith('.part') &&
      !entry.endsWith('.ytdl') &&
      !entry.includes('.temp.')
    ) {
      const candidate = path.join(tmpDir, entry);
      const stats = await fs.promises.stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Cleans stale staging files from `.mediavault-tmp` and, when `DOWNLOAD_TTL_MINUTES > 0`,
 * removes expired finished files from `/data/downloads` and marks jobs `expired`.
 */
async function runStorageCleanup({
  downloadsDir = DOWNLOADS_DIR,
  downloadTtlMs = DOWNLOAD_TTL_MS,
} = {}) {
  if (isCleanupRunning) return;
  isCleanupRunning = true;

  try {
    const resolvedDownloadsDir = path.resolve(downloadsDir);
    const tmpDir = path.join(resolvedDownloadsDir, '.mediavault-tmp');
    await fs.promises.mkdir(resolvedDownloadsDir, { recursive: true });
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const nowMs = Date.now();

    const tmpEntries = await fs.promises.readdir(tmpDir);
    for (const entry of tmpEntries) {
      if (entry === '.gitkeep') {
        continue;
      }
      const tmpPath = path.join(tmpDir, entry);
      try {
        const stats = await fs.promises.stat(tmpPath);
        if (stats.isFile() && nowMs - stats.mtimeMs > ORPHAN_TMP_MAX_AGE_MS) {
          await unlinkIfSafe(tmpPath, resolvedDownloadsDir);
        }
      } catch {
        // Ignore transient temp file stat errors
      }
    }

    if (downloadTtlMs <= 0) {
      return;
    }

    const affectedBatchIds = new Set();
    const now = new Date();
    const expiredJobs = await Job.find({
      status: 'ready',
      expiresAt: { $ne: null, $lte: now },
    })
      .select('_id filePath batchId')
      .lean();

    for (const job of expiredJobs) {
      if (job.filePath) {
        const removed = await unlinkIfSafe(job.filePath, resolvedDownloadsDir);
        if (!removed) continue;
        await removeEmptyPlaylistDirIfSafe(job.filePath, resolvedDownloadsDir);
      }
      await Job.findByIdAndUpdate(job._id, {
        status: 'expired',
        filePath: null,
      });
      if (job.batchId) {
        affectedBatchIds.add(job.batchId);
      }
    }

    const orphanCandidates = await collectExpiredCandidateFiles(
      resolvedDownloadsDir,
      nowMs,
      downloadTtlMs
    );
    for (const fullPath of orphanCandidates) {
      const removed = await unlinkIfSafe(fullPath, resolvedDownloadsDir);
      if (!removed) continue;
      await removeEmptyPlaylistDirIfSafe(fullPath, resolvedDownloadsDir);
      const orphanJobs = await Job.find({ filePath: fullPath })
        .select('batchId')
        .lean();
      for (const orphanJob of orphanJobs) {
        if (orphanJob.batchId) {
          affectedBatchIds.add(orphanJob.batchId);
        }
      }
      await Job.updateMany(
        { filePath: fullPath },
        { status: 'expired', filePath: null }
      );
    }

    for (const batchId of affectedBatchIds) {
      await updateBatchRollup(batchId).catch(() => {});
    }
  } catch (err) {
    console.error('Storage cleanup sweep error:', err.message);
  } finally {
    isCleanupRunning = false;
  }
}

function runYtDlpDownload({
  args,
  env = process.env,
  onProgress,
  onMuxing,
  onController,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdoutRemainder = '';
    let stderrText = '';
    let settled = false;
    let stoppedReason = null;
    let forceKillTimer = null;
    let stallTimer = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (err) reject(err);
      else resolve(result);
    };

    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore if already exited
      }
      forceKillTimer = setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }
      }, 3000);
      forceKillTimer.unref();
    };

    const resetStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
      stallTimer = setTimeout(() => {
        if (settled || stoppedReason) return;
        killChild();
        const stallErr = new Error(
          'Network connection lost or stalled — click Retry to resume.'
        );
        stallErr.code = 'NETWORK_STALLED';
        finish(stallErr);
      }, STALL_TIMEOUT_MS);
      stallTimer.unref();
    };

    if (typeof onController === 'function') {
      onController({
        stop(reason) {
          if (settled || stoppedReason) return;
          stoppedReason = reason;
          killChild();
        },
      });
    }

    const timeoutTimer = setTimeout(() => {
      killChild();
      finish(new Error('yt-dlp download timed out after 30 minutes.'));
    }, JOB_TIMEOUT_MS);
    timeoutTimer.unref();

    resetStallTimer();

    let streamIndex = 0;
    let sawStreamProgress = false;

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (
        /^\[download\]\s+Destination:/i.test(trimmed) ||
        /^\[download\]\s+.+\s+has already been downloaded/i.test(trimmed)
      ) {
        if (sawStreamProgress) {
          streamIndex += 1;
          sawStreamProgress = false;
        }
        return;
      }
      if (detectMuxingPhase(trimmed)) {
        onMuxing();
        return;
      }
      const parsed = parseYtDlpProgressLine(trimmed);
      if (parsed) {
        sawStreamProgress = true;
        onProgress({ ...parsed, streamIndex });
      }
    };

    child.stdout.on('data', (chunk) => {
      resetStallTimer();
      const combined = stdoutRemainder + chunk.toString('utf8');
      const lines = combined.split(/\r?\n|\r/);
      stdoutRemainder = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      resetStallTimer();
      if (stderrText.length < 64 * 1024) {
        stderrText += chunk.toString('utf8');
      }
    });

    child.on('error', (err) => {
      finish(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      if (stdoutRemainder) {
        processLine(stdoutRemainder);
        stdoutRemainder = '';
      }
      if (settled) return;

      if (stoppedReason) {
        finish(null, { code, stoppedReason });
        return;
      }

      if (code !== 0) {
        const lines = stderrText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const errLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l));
        const rawMessage = errLine
          ? errLine.replace(/^ERROR:\s*/i, '')
          : lines[lines.length - 1] || `yt-dlp exited with code ${code}`;
        finish(new Error(redactProxyCredentials(rawMessage)));
        return;
      }

      finish(null, { code, stoppedReason: null });
    });
  });
}

async function processJob(bullJob, deps) {
  const jobId = bullJob?.data?.jobId;
  if (!jobId) {
    return;
  }

  const runtimeDeps = deps && typeof deps === 'object' ? deps : {};
  const downloadsDir = path.resolve(runtimeDeps.downloadsDir || DOWNLOADS_DIR);
  const tmpDownloadsDir = path.join(downloadsDir, '.mediavault-tmp');
  const resolvePublicUrlFn = runtimeDeps.resolvePublicUrl || resolvePublicUrl;
  const createPinnedSsrfProxyFn = runtimeDeps.createPinnedSsrfProxy || createPinnedSsrfProxy;
  const runYtDlpDownloadFn = runtimeDeps.runYtDlpDownload || runYtDlpDownload;

  const job = await Job.findById(jobId);
  if (!job || ['cancelled', 'paused', 'ready'].includes(job.status)) {
    return;
  }

  let currentStatus = 'downloading';
  let maxProgress = Math.min(94, Math.max(0, Number(job.progress || 0)));
  let lastDbProgress = maxProgress;
  let knownTotalSizeBytes = Math.max(0, Number(job.totalSizeBytes || job.fileSizeBytes || 0));
  let lastDbTotalSizeBytes = knownTotalSizeBytes;
  const streamSizeBytes = new Map();
  let lastDbWriteMs = 0;
  let reachedMuxingPhase = false;
  let pausedByRequest = false;
  let cancelledForRetry = false;
  let cancelledByRequest = false;
  let workerOwnsActiveJob = false;
  let ownershipLost = false;
  let progressWriteChain = Promise.resolve(true);
  let activeDownloadController = null;

  activeJobControllers.set(jobId, {
    pause: () => {
      if (cancelledForRetry || cancelledByRequest) return;
      pausedByRequest = true;
      activeDownloadController?.stop('paused');
    },
    cancelForRetry: () => {
      if (cancelledByRequest) return;
      cancelledForRetry = true;
      activeDownloadController?.stop('retry');
    },
    cancel: () => {
      cancelledByRequest = true;
      activeDownloadController?.stop('cancelled');
    },
  });

  const publishProgress = (
    {
      status,
      progress,
      downloadSpeed = null,
      eta = null,
      totalSizeBytes = knownTotalSizeBytes,
    },
    forceDb = false
  ) => {
    if (pausedByRequest || cancelledForRetry || cancelledByRequest || ownershipLost) {
      return Promise.resolve(false);
    }

    const now = Date.now();
    const statusChanged = status !== currentStatus;
    currentStatus = status;
    maxProgress = Math.max(maxProgress, progress);
    if (Number.isFinite(totalSizeBytes) && totalSizeBytes > knownTotalSizeBytes) {
      knownTotalSizeBytes = Math.round(totalSizeBytes);
    }
    const sizeChangedSinceDb = knownTotalSizeBytes !== lastDbTotalSizeBytes;

    const shouldWrite =
      forceDb ||
      statusChanged ||
      sizeChangedSinceDb ||
      maxProgress - lastDbProgress >= 2 ||
      now - lastDbWriteMs >= 500;

    if (!shouldWrite) {
      return Promise.resolve(true);
    }

    lastDbProgress = maxProgress;
    lastDbTotalSizeBytes = knownTotalSizeBytes;
    lastDbWriteMs = now;

    const nextStatus = currentStatus;
    const nextProgress = maxProgress;
    const nextTotalSizeBytes = knownTotalSizeBytes;

    progressWriteChain = progressWriteChain.then(async () => {
      if (pausedByRequest || cancelledForRetry || cancelledByRequest || ownershipLost) {
        return false;
      }

      let updated;
      try {
        updated = await Job.findOneAndUpdate(
          { _id: jobId, status: { $in: ['downloading', 'muxing'] } },
          {
            status: nextStatus,
            progress: nextProgress,
            downloadSpeed,
            eta,
            totalSizeBytes: nextTotalSizeBytes,
          },
          { new: true }
        );
      } catch {
        return false;
      }

      if (!updated) {
        ownershipLost = true;
        activeDownloadController?.stop('external');
        return false;
      }

      if (pausedByRequest || cancelledForRetry || cancelledByRequest || ownershipLost) {
        return false;
      }

      await mediaQueue.setJobProgressCache(jobId, {
        status: nextStatus,
        progress: nextProgress,
        downloadSpeed,
        eta,
        totalSizeBytes: nextTotalSizeBytes,
      }).catch(() => {});

      return true;
    });

    return progressWriteChain;
  };

  const persistPausedState = async () => {
    await progressWriteChain.catch(() => {});
    await Job.findOneAndUpdate(
      { _id: jobId, status: { $in: ['downloading', 'muxing', 'paused'] } },
      {
        status: 'paused',
        progress: maxProgress,
        downloadSpeed: null,
        eta: null,
        totalSizeBytes: knownTotalSizeBytes,
        errorMessage: null,
      },
      { new: true }
    ).catch(() => {});
    await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
  };

  let cookieHandle = null;
  let ssrfProxy = null;

  try {
    const validated = validateMediaUrl(job.sourceUrl);
    const resolved = await resolvePublicUrlFn(validated.url, {
      lookup: runtimeDeps.lookup,
    });

    try {
      await assertSufficientDiskSpace(downloadsDir);
    } catch (diskErr) {
      if (diskErr instanceof AppError && diskErr.code === 'DISK_FULL') {
        await runStorageCleanup({ downloadsDir });
        await assertSufficientDiskSpace(downloadsDir);
      } else {
        throw diskErr;
      }
    }

    if (job.useCookies === true) {
      cookieHandle = await prepareCookieArg(validated.platform);
    }
    const cookiePath = cookieHandle ? cookieHandle.cookiePath : null;

    const latestBeforeSpawn = await Job.findById(jobId).select('status').lean();
    if (cancelledByRequest || !latestBeforeSpawn || latestBeforeSpawn.status === 'cancelled') {
      await cleanupPartialFiles(jobId, downloadsDir);
      await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
      return;
    }
    if (cancelledForRetry) {
      return;
    }
    if (pausedByRequest || latestBeforeSpawn.status === 'paused') {
      await persistPausedState();
      return;
    }

    const claimedJob = await Job.findOneAndUpdate(
      { _id: jobId, status: { $in: ['queued', 'downloading'] } },
      {
        status: 'downloading',
        progress: maxProgress,
        downloadSpeed: null,
        eta: null,
        totalSizeBytes: knownTotalSizeBytes,
      },
      { new: true }
    );
    if (!claimedJob || pausedByRequest || cancelledForRetry || cancelledByRequest) {
      if (cancelledByRequest) {
        await cleanupPartialFiles(jobId, downloadsDir);
      } else if (pausedByRequest) {
        await persistPausedState();
      }
      await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
      return;
    }

    workerOwnsActiveJob = true;
    lastDbProgress = maxProgress;
    lastDbTotalSizeBytes = knownTotalSizeBytes;
    lastDbWriteMs = Date.now();
    await mediaQueue.setJobProgressCache(jobId, {
      status: 'downloading',
      progress: maxProgress,
      downloadSpeed: null,
      eta: null,
      totalSizeBytes: knownTotalSizeBytes,
    }).catch(() => {});

    await fs.promises.mkdir(tmpDownloadsDir, { recursive: true });
    const outputTemplate = path.join(tmpDownloadsDir, `${jobId}.%(ext)s`);
    let finalContainer = job.container;

    const forceIpv4 = process.env.YTDLP_FORCE_IPV4 !== 'false';
    ssrfProxy = await createPinnedSsrfProxyFn({
      pinnedHosts: new Map([[resolved.hostname, resolved.addresses]]),
      preferIpv4: forceIpv4,
      lookup: runtimeDeps.lookup,
    });
    const proxyEnv = buildProxyChildEnv(ssrfProxy.proxyUrl);

    const executeDownload = async (targetContainer) => {
      const args = buildYtDlpJobArgs({
        url: validated.url,
        mode: job.mode,
        container: targetContainer,
        formatSelector: job.formatSelector,
        outputTemplate,
        cookiePath,
        proxyUrl: ssrfProxy.proxyUrl,
      });

      return runYtDlpDownloadFn({
        args,
        env: proxyEnv,
        onController: (controller) => {
          activeDownloadController = controller;
          if (cancelledByRequest) {
            controller.stop('cancelled');
          } else if (cancelledForRetry) {
            controller.stop('retry');
          } else if (pausedByRequest) {
            controller.stop('paused');
          } else if (ownershipLost) {
            controller.stop('external');
          }
        },
        onProgress: ({ percentage, totalSize, downloadSpeed, eta, streamIndex = 0 }) => {
          const parsedBytes = parseHumanSizeToBytes(totalSize);
          if (parsedBytes > 0) {
            streamSizeBytes.set(streamIndex, parsedBytes);
            let summed = 0;
            for (const size of streamSizeBytes.values()) {
              summed += size;
            }
            if (summed > knownTotalSizeBytes) {
              knownTotalSizeBytes = summed;
            }
          }
          const scaled = Math.min(94, Math.floor(percentage * 0.94));
          void publishProgress({
            status: currentStatus === 'muxing' ? 'muxing' : 'downloading',
            progress: scaled,
            downloadSpeed,
            eta,
            totalSizeBytes: knownTotalSizeBytes,
          });
        },
        onMuxing: () => {
          reachedMuxingPhase = true;
          void publishProgress(
            {
              status: 'muxing',
              progress: 95,
              downloadSpeed: null,
              eta: null,
              totalSizeBytes: knownTotalSizeBytes,
            },
            true
          );
        },
      });
    };

    try {
      await executeDownload(finalContainer);
    } catch (downloadErr) {
      await progressWriteChain.catch(() => {});

      if (cancelledByRequest) {
        await cleanupPartialFiles(jobId, downloadsDir);
        await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
        return;
      }
      if (pausedByRequest || cancelledForRetry || ownershipLost) {
        if (pausedByRequest && !cancelledForRetry && !ownershipLost) {
          await persistPausedState();
        }
        return;
      }

      if (ssrfProxy && ssrfProxy.getLastBlockedError()) {
        throw new AppError(
          400,
          'INVALID_URL',
          'Target URL or redirect resolved to a restricted IP address.'
        );
      }

      const shouldFallbackToMkv =
        job.mode === 'video' &&
        finalContainer !== 'mkv' &&
        (reachedMuxingPhase || /mux|merge|ffmpeg|codec|container/i.test(downloadErr.message));

      if (!shouldFallbackToMkv) {
        throw downloadErr;
      }

      console.warn(
        `Job ${jobId}: muxing into ${finalContainer} failed (${downloadErr.message}); falling back to MKV stream-copy.`
      );
      await cleanupPartialFiles(jobId, downloadsDir);
      finalContainer = 'mkv';
      reachedMuxingPhase = false;
      maxProgress = 0;
      lastDbProgress = 0;
      streamSizeBytes.clear();
      const fallbackStillActive = await publishProgress(
        {
          status: 'downloading',
          progress: 0,
          downloadSpeed: null,
          eta: null,
          totalSizeBytes: knownTotalSizeBytes,
        },
        true
      );
      if (!fallbackStillActive) {
        return;
      }
      await executeDownload('mkv');
    }

    await progressWriteChain.catch(() => {});

    if (cancelledByRequest) {
      await cleanupPartialFiles(jobId, downloadsDir);
      await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
      return;
    }
    if (cancelledForRetry || ownershipLost) {
      return;
    }

    const postRunDoc = await Job.findById(jobId).select('status').lean();
    if (pausedByRequest || postRunDoc?.status === 'paused') {
      await persistPausedState();
      return;
    }
    if (!postRunDoc || postRunDoc.status === 'cancelled') {
      await cleanupPartialFiles(jobId, downloadsDir);
      await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
      return;
    }

    const outputPath = await findJobOutputFile(jobId, finalContainer, downloadsDir);
    if (!outputPath) {
      throw new Error('Completed media file was not found in downloads directory.');
    }

    const detectedExt = path.extname(outputPath).replace(/^\./, '').toLowerCase();
    if (['mp4', 'mkv', 'webm', 'mp3'].includes(detectedExt)) {
      finalContainer = detectedExt;
    }

    let targetDir = downloadsDir;
    if (job.batchId) {
      const batch = await Batch.findOne({ batchId: job.batchId })
        .select('playlistTitle')
        .lean();
      if (batch && batch.playlistTitle) {
        targetDir = path.join(downloadsDir, sanitizeFolderName(batch.playlistTitle));
      }
    }

    const desiredFileName = sanitizeFilename(job.title, finalContainer);
    const moved = await moveToUniquePath(outputPath, targetDir, desiredFileName);
    const stats = await fs.promises.stat(moved.filePath);
    const expiresAt = DOWNLOAD_TTL_MS > 0 ? new Date(Date.now() + DOWNLOAD_TTL_MS) : null;

    const updatedDoc = await Job.findOneAndUpdate(
      { _id: jobId, status: { $in: ['downloading', 'muxing'] } },
      {
        status: 'ready',
        progress: 100,
        downloadSpeed: null,
        eta: '00:00',
        container: finalContainer,
        filePath: moved.filePath,
        fileName: moved.fileName,
        fileSizeBytes: stats.size,
        totalSizeBytes: stats.size,
        errorMessage: null,
        expiresAt,
      }
    );

    if (!updatedDoc || cancelledByRequest) {
      await unlinkIfSafe(moved.filePath, downloadsDir);
      await removeEmptyPlaylistDirIfSafe(moved.filePath, downloadsDir);
      if (cancelledByRequest) await cleanupPartialFiles(jobId, downloadsDir);
      await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
      await updateBatchRollup(job.batchId).catch(() => {});
      return;
    }

    await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
    try {
      await updateBatchRollup(job.batchId);
    } catch (rollupErr) {
      console.error(
        `Job ${jobId} ready, but batch rollup update failed:`,
        rollupErr.message
      );
    }
    console.log(`Job ${jobId} ready (${finalContainer}, ${stats.size} bytes)`);
  } catch (err) {
    await progressWriteChain.catch(() => {});

    if (cancelledByRequest) {
      await cleanupPartialFiles(jobId, downloadsDir);
      await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
      return;
    }
    if (cancelledForRetry || ownershipLost) {
      return;
    }
    if (pausedByRequest) {
      await persistPausedState();
      return;
    }

    const activeFailureStatuses = workerOwnsActiveJob
      ? ['downloading', 'muxing']
      : ['queued'];

    // Preserve `.part` files in `.mediavault-tmp` so clicking Retry resumes via `--continue`.
    const failedDoc = await Job.findOneAndUpdate(
      { _id: jobId, status: { $in: activeFailureStatuses } },
      {
        status: 'failed',
        progress: maxProgress,
        downloadSpeed: null,
        eta: null,
        totalSizeBytes: knownTotalSizeBytes,
        errorMessage: err.message || 'Download job failed.',
      },
      { new: true }
    ).catch(() => null);

    if (!failedDoc) {
      return;
    }

    await mediaQueue.clearJobProgressCache(jobId).catch(() => {});
    await updateBatchRollup(job.batchId).catch(() => {});
    console.error(`Job ${jobId} failed:`, err.message);
    throw err;
  } finally {
    activeJobControllers.delete(jobId);
    if (ssrfProxy) {
      await ssrfProxy.close();
    }
    if (cookieHandle) {
      await cookieHandle.cleanup();
    }
  }
}

async function start() {
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
  await fs.promises.mkdir(TMP_DOWNLOADS_DIR, { recursive: true });
  await connectDB();
  await Job.ensureNonTtlExpiresIndex();

  const interruptedJobs = await Job.find({ status: { $in: ['downloading', 'muxing'] } })
    .select('batchId')
    .lean();
  const recoveryBatchIds = Array.from(
    new Set(interruptedJobs.map((job) => job.batchId).filter(Boolean))
  );

  const recoveryResult = await Job.updateMany(
    { status: { $in: ['downloading', 'muxing'] } },
    {
      status: 'failed',
      downloadSpeed: null,
      eta: null,
      errorMessage: 'Connection interrupted or worker restarted — click Retry to resume.',
    }
  );
  if (recoveryResult.modifiedCount > 0) {
    for (const batchId of recoveryBatchIds) {
      await updateBatchRollup(batchId).catch(() => {});
    }
    console.log(`Recovered ${recoveryResult.modifiedCount} interrupted job(s) for retry.`);
  }

  controlSubscriber = createRedisConnection();
  controlSubscriber.on('message', (channel, rawMessage) => {
    if (channel !== JOB_CONTROL_CHANNEL) return;
    try {
      const payload = JSON.parse(rawMessage);
      if (payload.action === 'pause' && payload.jobId) {
        activeJobControllers.get(String(payload.jobId))?.pause();
      } else if (payload.action === 'pause-many' && Array.isArray(payload.jobIds)) {
        for (const id of payload.jobIds) {
          activeJobControllers.get(String(id))?.pause();
        }
      } else if (payload.action === 'cancel-for-retry' && payload.jobId) {
        activeJobControllers.get(String(payload.jobId))?.cancelForRetry();
      } else if (payload.action === 'cancel' && payload.jobId) {
        activeJobControllers.get(String(payload.jobId))?.cancel();
      } else if (payload.action === 'cancel-many' && Array.isArray(payload.jobIds)) {
        for (const id of payload.jobIds) {
          activeJobControllers.get(String(id))?.cancel();
        }
      }
    } catch {
      // Ignore malformed control payload
    }
  });
  await controlSubscriber.subscribe(JOB_CONTROL_CHANNEL);

  workerConnection = createRedisConnection();
  workerInstance = new Worker(MEDIA_QUEUE_NAME, (job) => processJob(job), {
    connection: workerConnection,
    concurrency: WORKER_CONCURRENCY,
  });

  workerInstance.on('ready', () => {
    console.log(
      `MediaVault Worker listening on queue "${MEDIA_QUEUE_NAME}" (concurrency=${WORKER_CONCURRENCY})`
    );
  });

  workerInstance.on('failed', (job, err) => {
    console.error(`BullMQ job ${job ? job.id : 'unknown'} failed:`, err.message);
  });

  workerInstance.on('error', (err) => {
    console.error('BullMQ worker error:', err.message);
  });

  await runStorageCleanup();
  cleanupTimer = setInterval(() => {
    void runStorageCleanup();
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down worker...`);
  try {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    if (workerInstance) {
      await workerInstance.close();
      workerInstance = null;
    }
    if (controlSubscriber) {
      await controlSubscriber.quit();
      controlSubscriber = null;
    }
    if (workerConnection) {
      await workerConnection.quit();
      workerConnection = null;
    }
    await disconnectDB();
  } catch (err) {
    console.error('Error during worker shutdown:', err.message);
  } finally {
    process.exit(0);
  }
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  start().catch((err) => {
    console.error('Failed to start MediaVault Worker:', err);
    process.exit(1);
  });
}

module.exports = {
  processJob,
  runStorageCleanup,
  runYtDlpDownload,
};
