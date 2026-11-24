const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const Batch = require('../models/Batch');
const Job = require('../models/Job');
const { enqueueMediaJob, getJobProgressCache } = require('../queues/mediaQueue');
const { AppError } = require('../utils/errors');
const { sanitizeFilename } = require('../utils/formatMapper');
const { assertPublicUrl } = require('../utils/ssrf');
const { assertSufficientDiskSpace, enforce1080pSelector } = require('../utils/workerHelpers');
const { resolveCookieFile, validateMediaUrl } = require('../utils/ytdlp');

const router = express.Router();

const VALID_CONTAINERS = new Set(['mp4', 'mkv', 'webm', 'mp3']);
const VALID_MODES = new Set(['video', 'audio']);
const VALID_STATUSES = new Set([
  'queued',
  'downloading',
  'muxing',
  'ready',
  'failed',
  'expired',
  'cancelled',
]);
const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'muxing']);
const MAX_BATCH_ITEMS = 50;

function getDownloadsDir() {
  return path.resolve(process.env.DOWNLOADS_DIR || '/data/downloads');
}

function getRequestUserId(req) {
  if (!req.user || !req.user.id) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
  }
  return req.user.id;
}

function serializeJobSummary(job) {
  return {
    id: job._id.toString(),
    batchId: job.batchId || null,
    sourceUrl: job.sourceUrl,
    title: job.title,
    thumbnailUrl: job.thumbnailUrl || null,
    duration: job.duration || 0,
    platform: job.platform,
    container: job.container,
    mode: job.mode,
    formatSelector: job.formatSelector,
    useCookies: job.useCookies === true,
    status: job.status,
    progress: job.progress,
    downloadSpeed: job.downloadSpeed || null,
    eta: job.eta || null,
    errorMessage: job.errorMessage || null,
    fileName: job.fileName || null,
    fileSizeBytes: job.fileSizeBytes || 0,
    expiresAt: job.expiresAt || null,
    createdAt: job.createdAt,
  };
}

/**
 * POST /api/jobs
 * Creates single or batch asynchronous download jobs in MongoDB and pushes them to BullMQ.
 */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawItems = Array.isArray(body.items) ? body.items : [body];

    if (rawItems.length === 0) {
      throw new AppError(400, 'INVALID_REQUEST', 'At least one download item is required.');
    }

    if (rawItems.length > MAX_BATCH_ITEMS) {
      throw new AppError(
        400,
        'INVALID_REQUEST',
        `A single batch cannot exceed ${MAX_BATCH_ITEMS} items.`
      );
    }

    await assertSufficientDiskSpace(getDownloadsDir());

    const userId = getRequestUserId(req);
    const playlistUrl =
      typeof body.playlistUrl === 'string' && body.playlistUrl.trim()
        ? body.playlistUrl.trim()
        : null;
    if (playlistUrl) {
      const validatedPlaylist = validateMediaUrl(playlistUrl);
      await assertPublicUrl(validatedPlaylist.url);
    }

    const fallbackUrl =
      typeof body.sourceUrl === 'string'
        ? body.sourceUrl.trim()
        : typeof body.url === 'string'
          ? body.url.trim()
          : playlistUrl || '';
    const defaultUseCookies = body.useCookies === true;

    const sharedFormat =
      body.format && typeof body.format === 'object' ? body.format : {};
    const sharedContainer =
      typeof sharedFormat.container === 'string'
        ? sharedFormat.container
        : typeof body.container === 'string'
          ? body.container
          : null;
    const sharedMode =
      typeof sharedFormat.mode === 'string'
        ? sharedFormat.mode
        : typeof body.mode === 'string'
          ? body.mode
          : null;
    const sharedFormatSelector =
      typeof sharedFormat.formatSelector === 'string'
        ? sharedFormat.formatSelector
        : typeof body.formatSelector === 'string'
          ? body.formatSelector
          : null;

    const normalizedItems = [];
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== 'object') {
        throw new AppError(400, 'INVALID_REQUEST', 'Each item must be an object.');
      }

      const itemUrl =
        typeof rawItem.sourceUrl === 'string' && rawItem.sourceUrl.trim()
          ? rawItem.sourceUrl.trim()
          : typeof rawItem.url === 'string' && rawItem.url.trim()
            ? rawItem.url.trim()
            : fallbackUrl;

      const validated = validateMediaUrl(itemUrl);
      await assertPublicUrl(validated.url);

      const resolvedModeHint =
        typeof rawItem.mode === 'string' ? rawItem.mode : sharedMode;
      const resolvedContainerHint =
        typeof rawItem.container === 'string' ? rawItem.container : sharedContainer;

      const rawContainer = resolvedContainerHint
        ? resolvedContainerHint.trim().toLowerCase()
        : String(resolvedModeHint || '').trim().toLowerCase() === 'audio'
          ? 'mp3'
          : 'mp4';

      if (!VALID_CONTAINERS.has(rawContainer)) {
        throw new AppError(
          400,
          'INVALID_REQUEST',
          `Unsupported container "${rawContainer}". Allowed: mp4, mkv, webm, mp3.`
        );
      }

      const mode = resolvedModeHint
        ? resolvedModeHint.trim().toLowerCase()
        : rawContainer === 'mp3'
          ? 'audio'
          : 'video';

      if (!VALID_MODES.has(mode)) {
        throw new AppError(400, 'INVALID_REQUEST', `Unsupported mode "${mode}".`);
      }

      if (mode === 'audio' && rawContainer !== 'mp3') {
        throw new AppError(400, 'INVALID_REQUEST', 'Audio mode only supports the mp3 container.');
      }
      if (mode === 'video' && rawContainer === 'mp3') {
        throw new AppError(400, 'INVALID_REQUEST', 'Video mode cannot use the mp3 container.');
      }

      const useCookies =
        rawItem.useCookies !== undefined ? rawItem.useCookies === true : defaultUseCookies;

      if (useCookies) {
        await resolveCookieFile(validated.platform);
      }

      const formatSelector = enforce1080pSelector(
        typeof rawItem.formatSelector === 'string'
          ? rawItem.formatSelector
          : sharedFormatSelector,
        mode,
        rawContainer
      );

      normalizedItems.push({
        sourceUrl: validated.url,
        platform: validated.platform,
        title:
          typeof rawItem.title === 'string' && rawItem.title.trim()
            ? rawItem.title.trim()
            : 'Media File',
        thumbnailUrl:
          typeof rawItem.thumbnailUrl === 'string' && rawItem.thumbnailUrl.trim()
            ? rawItem.thumbnailUrl.trim()
            : typeof rawItem.thumbnail === 'string' && rawItem.thumbnail.trim()
              ? rawItem.thumbnail.trim()
              : null,
        duration: Number.isFinite(Number(rawItem.duration)) ? Number(rawItem.duration) : 0,
        mode,
        container: rawContainer,
        formatSelector,
        useCookies,
      });
    }

    let batchId = null;
    if (normalizedItems.length > 1 || Boolean(playlistUrl)) {
      batchId = crypto.randomUUID();
      await Batch.create({
        batchId,
        userId,
        playlistTitle:
          typeof body.playlistTitle === 'string' && body.playlistTitle.trim()
            ? body.playlistTitle.trim()
            : 'Playlist Download Batch',
        playlistUrl: playlistUrl || fallbackUrl || normalizedItems[0].sourceUrl,
        totalItems: normalizedItems.length,
        status: 'processing',
      });
    }

    const createdJobs = await Job.insertMany(
      normalizedItems.map((item) => ({
        ...item,
        userId,
        batchId,
        status: 'queued',
        progress: 0,
      }))
    );

    const jobIds = [];
    for (const jobDoc of createdJobs) {
      try {
        await enqueueMediaJob(jobDoc);
        jobIds.push(jobDoc._id.toString());
      } catch (queueErr) {
        await Job.findByIdAndUpdate(jobDoc._id, {
          status: 'failed',
          errorMessage: `Failed to enqueue job: ${queueErr.message}`,
        });
        throw queueErr;
      }
    }

    return res.status(202).json({
      success: true,
      batchId,
      jobIds,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/jobs
 * Lists paginated download job history for the current user.
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));

    const filter = { userId };
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      const requestedStatus = req.query.status.trim().toLowerCase();
      if (!VALID_STATUSES.has(requestedStatus)) {
        throw new AppError(400, 'INVALID_REQUEST', `Invalid status filter "${requestedStatus}".`);
      }
      filter.status = requestedStatus;
    }
    if (typeof req.query.batchId === 'string' && req.query.batchId.trim()) {
      filter.batchId = req.query.batchId.trim();
    }

    const [total, jobs] = await Promise.all([
      Job.countDocuments(filter),
      Job.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const enrichedJobs = await Promise.all(
      jobs.map(async (job) => {
        const serialized = serializeJobSummary(job);
        if (!ACTIVE_STATUSES.has(serialized.status)) {
          return serialized;
        }
        const cached = await getJobProgressCache(serialized.id).catch(() => null);
        if (!cached) {
          return serialized;
        }
        return {
          ...serialized,
          status:
            cached.status && VALID_STATUSES.has(cached.status)
              ? cached.status
              : serialized.status,
          progress:
            typeof cached.progress === 'number' && Number.isFinite(cached.progress)
              ? Math.max(serialized.progress || 0, cached.progress)
              : serialized.progress,
          downloadSpeed: cached.downloadSpeed ?? serialized.downloadSpeed,
          eta: cached.eta ?? serialized.eta,
        };
      })
    );

    return res.status(200).json({
      jobs: enrichedJobs,
      pagination: {
        total,
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/jobs/expired
 * Deletes expired job history records belonging to the authenticated user.
 */
router.delete('/expired', async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    const result = await Job.deleteMany({ userId, status: 'expired' });
    return res.status(200).json({
      success: true,
      deletedCount: result?.deletedCount || 0,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/jobs/batches/:batchId
 * Returns batch progress rollup and child jobs for the authenticated user.
 */
router.get('/batches/:batchId', async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    const batchId = String(req.params.batchId || '').trim();
    const batch = await Batch.findOne({ batchId, userId }).lean();
    if (!batch) {
      throw new AppError(404, 'BATCH_NOT_FOUND', 'Requested batch ID does not exist.');
    }

    const jobs = await Job.find({ batchId, userId }).sort({ createdAt: 1 }).lean();

    return res.status(200).json({
      batch: {
        batchId: batch.batchId,
        playlistTitle: batch.playlistTitle,
        playlistUrl: batch.playlistUrl,
        totalItems: batch.totalItems,
        completedItems: batch.completedItems,
        failedItems: batch.failedItems,
        status: batch.status,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
      },
      jobs: jobs.map(serializeJobSummary),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/jobs/:id
 * Polls job execution state and live progress (overlaying volatile Redis progress cache).
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    const job = await Job.findOne({ _id: id, userId: getRequestUserId(req) }).lean();
    if (!job) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    let { status, progress, downloadSpeed, eta } = job;

    if (ACTIVE_STATUSES.has(status)) {
      const cached = await getJobProgressCache(id).catch(() => null);
      if (cached) {
        if (cached.status && VALID_STATUSES.has(cached.status)) {
          status = cached.status;
        }
        if (typeof cached.progress === 'number' && Number.isFinite(cached.progress)) {
          progress = Math.max(progress || 0, cached.progress);
        }
        downloadSpeed = cached.downloadSpeed ?? downloadSpeed;
        eta = cached.eta ?? eta;
      }
    }

    return res.status(200).json({
      id: job._id.toString(),
      batchId: job.batchId || null,
      status,
      progress,
      downloadSpeed: downloadSpeed || null,
      eta: eta || null,
      errorMessage: job.errorMessage || null,
      title: job.title,
      platform: job.platform,
      container: job.container,
      mode: job.mode,
      fileName: job.fileName || null,
      fileSizeBytes: job.fileSizeBytes || 0,
      expiresAt: job.expiresAt || null,
      createdAt: job.createdAt,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/jobs/:id/file
 * Streams the completed media file from `/data/downloads` as an attachment download.
 */
router.get('/:id/file', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    const job = await Job.findOne({ _id: id, userId: getRequestUserId(req) });
    if (!job) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    if (job.status === 'expired' || (job.expiresAt && job.expiresAt <= new Date())) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested download file has expired.');
    }

    if (job.status !== 'ready' || !job.filePath) {
      throw new AppError(
        409,
        'JOB_NOT_READY',
        `Job is currently in "${job.status}" state and not ready for download.`
      );
    }

    const downloadsDir = getDownloadsDir();
    const resolvedPath = path.resolve(job.filePath);
    if (!resolvedPath.startsWith(`${downloadsDir}${path.sep}`)) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested download file path is invalid.');
    }

    try {
      await fs.promises.access(resolvedPath, fs.constants.R_OK);
    } catch {
      await Job.findByIdAndUpdate(job._id, { status: 'expired', filePath: null });
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested download file no longer exists.');
    }

    const downloadName = job.fileName || sanitizeFilename(job.title, job.container);
    return res.download(resolvedPath, downloadName, (err) => {
      if (err && !res.headersSent) {
        next(err);
      }
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
