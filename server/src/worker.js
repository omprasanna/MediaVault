require('dotenv/config');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Worker } = require('bullmq');
const { connectDB, disconnectDB } = require('./config/db');
const Batch = require('./models/Batch');
const Job = require('./models/Job');
const {
  MEDIA_QUEUE_NAME,
  clearJobProgressCache,
  createRedisConnection,
  setJobProgressCache,
} = require('./queues/mediaQueue');
const { AppError } = require('./utils/errors');
const { sanitizeFilename } = require('./utils/formatMapper');
const { assertPublicUrl } = require('./utils/ssrf');
const {
  assertSufficientDiskSpace,
  buildYtDlpJobArgs,
  detectMuxingPhase,
  parseYtDlpProgressLine,
} = require('./utils/workerHelpers');
const { prepareCookieArg, validateMediaUrl } = require('./utils/ytdlp');

const WORKER_CONCURRENCY = Math.min(
  2,
  Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2))
);
const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR || '/data/downloads');
const DOWNLOAD_TTL_MS = Number(process.env.DOWNLOAD_TTL_MINUTES || 30) * 60 * 1000;
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MINUTES || 5) * 60 * 1000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

let isCleanupRunning = false;
let cleanupTimer = null;
let workerInstance = null;
let workerConnection = null;

function isSafeDownloadPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  return resolved.startsWith(`${DOWNLOADS_DIR}${path.sep}`);
}

async function unlinkIfSafe(filePath) {
  if (!isSafeDownloadPath(filePath)) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed to unlink ${filePath}:`, err.message);
    }
  }
}

async function cleanupPartialFiles(jobId) {
  try {
    const entries = await fs.promises.readdir(DOWNLOADS_DIR);
    for (const entry of entries) {
      if (entry.startsWith(`${jobId}.`)) {
        await unlinkIfSafe(path.join(DOWNLOADS_DIR, entry));
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed cleaning partial files for job ${jobId}:`, err.message);
    }
  }
}

async function findJobOutputFile(jobId, preferredContainer) {
  const preferredPath = path.join(DOWNLOADS_DIR, `${jobId}.${preferredContainer}`);
  try {
    const stats = await fs.promises.stat(preferredPath);
    if (stats.isFile()) {
      return preferredPath;
    }
  } catch {
    // Fall back to scanning prefix in case yt-dlp resolved a different extension.
  }

  const entries = await fs.promises.readdir(DOWNLOADS_DIR);
  for (const entry of entries) {
    if (
      entry.startsWith(`${jobId}.`) &&
      !entry.endsWith('.part') &&
      !entry.endsWith('.ytdl') &&
      !entry.includes('.temp.')
    ) {
      const candidate = path.join(DOWNLOADS_DIR, entry);
      const stats = await fs.promises.stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Removes expired download files from `/data/downloads` and marks corresponding
 * MongoDB Job documents as `expired`.
 */
async function runStorageCleanup() {
  if (isCleanupRunning) return;
  isCleanupRunning = true;

  try {
    await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
    const now = new Date();

    const expiredJobs = await Job.find({
      status: 'ready',
      expiresAt: { $ne: null, $lte: now },
    }).select('_id filePath');

    for (const job of expiredJobs) {
      if (job.filePath) {
        await unlinkIfSafe(job.filePath);
      }
      await Job.findByIdAndUpdate(job._id, {
        status: 'expired',
        filePath: null,
      });
    }

    const entries = await fs.promises.readdir(DOWNLOADS_DIR);
    const nowMs = Date.now();

    for (const entry of entries) {
      if (entry === '.gitkeep' || entry.startsWith('.')) {
        continue;
      }
      const fullPath = path.join(DOWNLOADS_DIR, entry);
      let stats;
      try {
        stats = await fs.promises.stat(fullPath);
      } catch {
        continue;
      }

      if (stats.isFile() && nowMs - stats.mtimeMs > DOWNLOAD_TTL_MS) {
        await unlinkIfSafe(fullPath);
        await Job.updateMany(
          { filePath: fullPath },
          { status: 'expired', filePath: null }
        );
      }
    }
  } catch (err) {
    console.error('Storage cleanup sweep error:', err.message);
  } finally {
    isCleanupRunning = false;
  }
}

async function updateBatchRollup(batchId) {
  if (!batchId) return;
  const batch = await Batch.findOne({ batchId });
  if (!batch) return;

  const [completedItems, failedItems] = await Promise.all([
    Job.countDocuments({ batchId, status: 'ready' }),
    Job.countDocuments({ batchId, status: { $in: ['failed', 'cancelled'] } }),
  ]);

  let status = 'processing';
  if (completedItems + failedItems >= batch.totalItems) {
    if (failedItems === 0) {
      status = 'completed';
    } else if (completedItems === 0) {
      status = 'failed';
    } else {
      status = 'partial_failure';
    }
  }

  await Batch.updateOne(
    { _id: batch._id },
    { completedItems, failedItems, status }
  );
}

function runYtDlpDownload({ args, onProgress, onMuxing }) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutRemainder = '';
    let stderrText = '';
    let settled = false;
    let forceKillTimer = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (err) reject(err);
      else resolve(result);
    };

    const killChild = () => {
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 3000);
      forceKillTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      killChild();
      finish(new Error('yt-dlp download timed out after 30 minutes.'));
    }, JOB_TIMEOUT_MS);
    timeoutTimer.unref();

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (detectMuxingPhase(trimmed)) {
        onMuxing();
        return;
      }
      const parsed = parseYtDlpProgressLine(trimmed);
      if (parsed) {
        onProgress(parsed);
      }
    };

    child.stdout.on('data', (chunk) => {
      const combined = stdoutRemainder + chunk.toString('utf8');
      const lines = combined.split(/\r?\n|\r/);
      stdoutRemainder = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
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

      if (code !== 0) {
        const lines = stderrText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const errLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l));
        const message = errLine
          ? errLine.replace(/^ERROR:\s*/i, '')
          : lines[lines.length - 1] || `yt-dlp exited with code ${code}`;
        finish(new Error(message));
        return;
      }

      finish(null, { code });
    });
  });
}

async function processJob(bullJob) {
  const jobId = bullJob?.data?.jobId;
  if (!jobId) {
    return;
  }

  const job = await Job.findById(jobId);
  if (!job || job.status === 'cancelled') {
    return;
  }

  let currentStatus = 'downloading';
  let lastDbProgress = 0;
  let lastDbWriteMs = 0;
  let lastCacheWriteMs = 0;
  let maxProgress = 0;
  let reachedMuxingPhase = false;

  const publishProgress = async (
    { status, progress, downloadSpeed = null, eta = null },
    forceDb = false
  ) => {
    const now = Date.now();
    const statusChanged = status !== currentStatus;
    currentStatus = status;
    maxProgress = Math.max(maxProgress, progress);

    if (forceDb || statusChanged || now - lastCacheWriteMs >= 400) {
      lastCacheWriteMs = now;
      await setJobProgressCache(jobId, {
        status: currentStatus,
        progress: maxProgress,
        downloadSpeed,
        eta,
      }).catch(() => {});
    }

    if (
      forceDb ||
      statusChanged ||
      maxProgress - lastDbProgress >= 2 ||
      now - lastDbWriteMs >= 1000
    ) {
      lastDbProgress = maxProgress;
      lastDbWriteMs = now;
      await Job.findByIdAndUpdate(jobId, {
        status: currentStatus,
        progress: maxProgress,
        downloadSpeed,
        eta,
      }).catch(() => {});
    }
  };

  let cookieHandle = null;

  try {
    const validated = validateMediaUrl(job.sourceUrl);
    await assertPublicUrl(validated.url);

    try {
      await assertSufficientDiskSpace(DOWNLOADS_DIR);
    } catch (diskErr) {
      if (diskErr instanceof AppError && diskErr.code === 'DISK_FULL') {
        await runStorageCleanup();
        await assertSufficientDiskSpace(DOWNLOADS_DIR);
      } else {
        throw diskErr;
      }
    }

    if (job.useCookies === true) {
      cookieHandle = await prepareCookieArg(validated.platform);
    }
    const cookiePath = cookieHandle ? cookieHandle.cookiePath : null;

    await publishProgress(
      { status: 'downloading', progress: 0, downloadSpeed: null, eta: null },
      true
    );

    const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);
    let finalContainer = job.container;

    const executeDownload = async (targetContainer) => {
      const args = buildYtDlpJobArgs({
        url: validated.url,
        mode: job.mode,
        container: targetContainer,
        formatSelector: job.formatSelector,
        outputTemplate,
        cookiePath,
      });

      await runYtDlpDownload({
        args,
        onProgress: ({ percentage, downloadSpeed, eta }) => {
          const scaled = Math.min(94, Math.floor(percentage * 0.94));
          void publishProgress({
            status: currentStatus === 'muxing' ? 'muxing' : 'downloading',
            progress: scaled,
            downloadSpeed,
            eta,
          });
        },
        onMuxing: () => {
          reachedMuxingPhase = true;
          void publishProgress(
            { status: 'muxing', progress: 95, downloadSpeed: null, eta: null },
            true
          );
        },
      });
    };

    try {
      await executeDownload(finalContainer);
    } catch (downloadErr) {
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
      await cleanupPartialFiles(jobId);
      finalContainer = 'mkv';
      reachedMuxingPhase = false;
      await publishProgress(
        { status: 'downloading', progress: 0, downloadSpeed: null, eta: null },
        true
      );
      await executeDownload('mkv');
    }

    const outputPath = await findJobOutputFile(jobId, finalContainer);
    if (!outputPath) {
      throw new Error('Completed media file was not found in downloads directory.');
    }

    const detectedExt = path.extname(outputPath).replace(/^\./, '').toLowerCase();
    if (['mp4', 'mkv', 'webm', 'mp3'].includes(detectedExt)) {
      finalContainer = detectedExt;
    }

    const stats = await fs.promises.stat(outputPath);
    const fileName = sanitizeFilename(job.title, finalContainer);
    const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_MS);

    await Job.findByIdAndUpdate(jobId, {
      status: 'ready',
      progress: 100,
      downloadSpeed: null,
      eta: '00:00',
      container: finalContainer,
      filePath: outputPath,
      fileName,
      fileSizeBytes: stats.size,
      errorMessage: null,
      expiresAt,
    });

    await clearJobProgressCache(jobId).catch(() => {});
    await updateBatchRollup(job.batchId);
    console.log(`Job ${jobId} ready (${finalContainer}, ${stats.size} bytes)`);
  } catch (err) {
    await cleanupPartialFiles(jobId);
    await Job.findByIdAndUpdate(jobId, {
      status: 'failed',
      downloadSpeed: null,
      eta: null,
      errorMessage: err.message || 'Download job failed.',
    }).catch(() => {});
    await clearJobProgressCache(jobId).catch(() => {});
    await updateBatchRollup(job.batchId).catch(() => {});
    console.error(`Job ${jobId} failed:`, err.message);
    throw err;
  } finally {
    if (cookieHandle) {
      await cookieHandle.cleanup();
    }
  }
}

async function start() {
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
  await connectDB();

  workerConnection = createRedisConnection();
  workerInstance = new Worker(MEDIA_QUEUE_NAME, processJob, {
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

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('Failed to start MediaVault Worker:', err);
  process.exit(1);
});
