const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const Batch = require('../models/Batch');
const Job = require('../models/Job');
const mediaQueue = require('../queues/mediaQueue');
const { AppError } = require('../utils/errors');
const { updateBatchRollup } = require('../utils/batchRollup');
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
  'paused',
  'ready',
  'failed',
  'expired',
  'cancelled',
]);
const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'muxing']);

function getMaxBatchItems() {
  const parsed = Number(process.env.MAX_BATCH_ITEMS || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

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
    totalSizeBytes: job.totalSizeBytes || job.fileSizeBytes || 0,
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

    const maxBatchItems = getMaxBatchItems();
    if (maxBatchItems > 0 && rawItems.length > maxBatchItems) {
      throw new AppError(
        400,
        'INVALID_REQUEST',
        `A single batch cannot exceed ${maxBatchItems} items.`
      );
    }

    await assertSufficientDiskSpace(getDownloadsDir());

    const userId = getRequestUserId(req);
    const verifiedHosts = new Set();
    const verifiedCookiePlatforms = new Set();

    const playlistUrl =
      typeof body.playlistUrl === 'string' && body.playlistUrl.trim()
        ? body.playlistUrl.trim()
        : null;
    if (playlistUrl) {
      const validatedPlaylist = validateMediaUrl(playlistUrl);
      if (!verifiedHosts.has(validatedPlaylist.hostname)) {
        await assertPublicUrl(validatedPlaylist.url);
        verifiedHosts.add(validatedPlaylist.hostname);
      }
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
      if (!verifiedHosts.has(validated.hostname)) {
        await assertPublicUrl(validated.url);
        verifiedHosts.add(validated.hostname);
      }

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

      if (useCookies && !verifiedCookiePlatforms.has(validated.platform)) {
        await resolveCookieFile(validated.platform);
        verifiedCookiePlatforms.add(validated.platform);
      }

      const formatSelector = enforce1080pSelector(
        typeof rawItem.formatSelector === 'string'
          ? rawItem.formatSelector
          : sharedFormatSelector,
        mode,
        rawContainer
      );

      const rawEstimatedSize = Number(
        rawItem.estimatedSizeBytes ?? rawItem.totalSizeBytes ?? rawItem.filesize
      );
      const estimatedSizeBytes =
        Number.isFinite(rawEstimatedSize) && rawEstimatedSize > 0
          ? Math.round(rawEstimatedSize)
          : 0;

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
        totalSizeBytes: estimatedSizeBytes,
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

    try {
      await mediaQueue.enqueueMediaJobsBulk(createdJobs);
    } catch (queueErr) {
      const createdIds = createdJobs.map((doc) => doc._id);
      await Job.updateMany(
        { _id: { $in: createdIds } },
        {
          status: 'failed',
          errorMessage: `Failed to enqueue job: ${queueErr.message}`,
        }
      );
      if (batchId) {
        await updateBatchRollup(batchId).catch(() => {});
      }
      throw queueErr;
    }

    const jobIds = createdJobs.map((doc) => doc._id.toString());

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
 * Lists paginated download job history for the current user with user-wide counts.
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    const userObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const prioritizeActive =
      String(req.query.prioritizeActive || '').toLowerCase() === 'true';

    const filter = { userId: userObjectId };
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      const requestedStatus = req.query.status.trim().toLowerCase();
      if (requestedStatus === 'active') {
        filter.status = { $in: ['queued', 'downloading', 'muxing'] };
      } else if (requestedStatus === 'primary') {
        filter.status = { $nin: ['expired', 'cancelled'] };
      } else if (requestedStatus === 'history') {
        filter.status = { $in: ['expired', 'cancelled'] };
      } else if (requestedStatus !== 'all') {
        if (!VALID_STATUSES.has(requestedStatus)) {
          throw new AppError(
            400,
            'INVALID_REQUEST',
            `Invalid status filter "${requestedStatus}".`
          );
        }
        filter.status = requestedStatus;
      }
    }

    if (typeof req.query.batchId === 'string' && req.query.batchId.trim()) {
      filter.batchId = req.query.batchId.trim();
    }

    const jobsQueryPromise = prioritizeActive
      ? Job.aggregate([
          { $match: filter },
          {
            $addFields: {
              _statusRank: {
                $switch: {
                  branches: [
                    { case: { $eq: ['$status', 'downloading'] }, then: 0 },
                    { case: { $eq: ['$status', 'muxing'] }, then: 1 },
                    { case: { $eq: ['$status', 'queued'] }, then: 2 },
                    { case: { $eq: ['$status', 'paused'] }, then: 3 },
                    { case: { $eq: ['$status', 'ready'] }, then: 4 },
                    { case: { $eq: ['$status', 'failed'] }, then: 5 },
                    { case: { $eq: ['$status', 'expired'] }, then: 6 },
                    { case: { $eq: ['$status', 'cancelled'] }, then: 7 },
                  ],
                  default: 8,
                },
              },
            },
          },
          { $sort: { _statusRank: 1, createdAt: -1, _id: 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ])
      : Job.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean();

    const [total, jobs, statusBuckets] = await Promise.all([
      Job.countDocuments(filter),
      jobsQueryPromise,
      Job.aggregate([
        { $match: { userId: userObjectId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const byStatus = Object.create(null);
    for (const bucket of statusBuckets) {
      byStatus[bucket._id] = bucket.count;
    }

    const activeCount =
      (byStatus.queued || 0) + (byStatus.downloading || 0) + (byStatus.muxing || 0);
    const pausedCount = byStatus.paused || 0;
    const readyCount = byStatus.ready || 0;
    const failedCount = byStatus.failed || 0;
    const historyCount = (byStatus.expired || 0) + (byStatus.cancelled || 0);

    const enrichedJobs = await Promise.all(
      jobs.map(async (job) => {
        const serialized = serializeJobSummary(job);
        if (!ACTIVE_STATUSES.has(serialized.status)) {
          return serialized;
        }
        const cached = await mediaQueue.getJobProgressCache(serialized.id).catch(() => null);
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
          totalSizeBytes: Math.max(
            serialized.totalSizeBytes || 0,
            cached.totalSizeBytes || 0
          ),
        };
      })
    );

    const pages = Math.max(1, Math.ceil(total / limit));

    return res.status(200).json({
      jobs: enrichedJobs,
      counts: {
        all: activeCount + pausedCount + readyCount + failedCount,
        active: activeCount,
        paused: pausedCount,
        ready: readyCount,
        failed: failedCount,
        history: historyCount,
      },
      pagination: {
        total,
        page,
        limit,
        pages,
        hasMore: page < pages,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/jobs/pause-all
 * Pauses all queued, downloading, or muxing jobs belonging to the authenticated user.
 */
router.post('/pause-all', async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    const activeJobs = await Job.find({
      userId,
      status: { $in: ['queued', 'downloading', 'muxing'] },
    })
      .select('_id status')
      .lean();

    if (activeJobs.length === 0) {
      return res.status(200).json({ success: true, pausedCount: 0 });
    }

    const candidateIds = activeJobs.map((j) => j._id);
    const updateResult = await Job.updateMany(
      {
        _id: { $in: candidateIds },
        userId,
        status: { $in: ['queued', 'downloading', 'muxing'] },
      },
      {
        status: 'paused',
        downloadSpeed: null,
        eta: null,
        errorMessage: null,
      }
    );

    const pausedCount =
      updateResult?.modifiedCount ?? updateResult?.matchedCount ?? 0;
    if (pausedCount === 0) {
      return res.status(200).json({ success: true, pausedCount: 0 });
    }

    let targetJobs = activeJobs;
    if (pausedCount < activeJobs.length) {
      const pausedDocs = await Job.find({
        _id: { $in: candidateIds },
        userId,
        status: 'paused',
      })
        .select('_id')
        .lean();
      const pausedIdSet = new Set(pausedDocs.map((doc) => doc._id.toString()));
      targetJobs = activeJobs.filter((item) =>
        pausedIdSet.has(item._id.toString())
      );
    }

    const queuedIds = [];
    const runningIds = [];
    const allIds = [];

    for (const item of targetJobs) {
      const idStr = item._id.toString();
      allIds.push(idStr);
      if (item.status === 'queued') {
        queuedIds.push(idStr);
      } else {
        runningIds.push(idStr);
      }
    }

    if (queuedIds.length > 0) {
      await Promise.all(queuedIds.map((id) => mediaQueue.removeQueuedMediaJob(id)));
    }

    await Promise.all(
      allIds.map((id) => mediaQueue.clearJobProgressCache(id).catch(() => {}))
    );

    if (runningIds.length > 0) {
      await mediaQueue.publishJobControl({ action: 'pause-many', jobIds: runningIds });
    }

    return res.status(200).json({
      success: true,
      pausedCount: targetJobs.length,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/jobs/resume-all
 * Requeues all paused jobs belonging to the authenticated user while retaining partial downloads.
 */
router.post('/resume-all', async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    await assertSufficientDiskSpace(getDownloadsDir());

    const pausedJobs = await Job.find({ userId, status: 'paused' })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    if (pausedJobs.length === 0) {
      return res.status(200).json({ success: true, resumedCount: 0 });
    }

    const candidateIds = pausedJobs.map((j) => j._id);
    const updateResult = await Job.updateMany(
      { _id: { $in: candidateIds }, userId, status: 'paused' },
      {
        status: 'queued',
        downloadSpeed: null,
        eta: null,
        errorMessage: null,
      }
    );

    const resumedCount =
      updateResult?.modifiedCount ?? updateResult?.matchedCount ?? 0;
    if (resumedCount === 0) {
      return res.status(200).json({ success: true, resumedCount: 0 });
    }

    let targetJobs = pausedJobs;
    if (resumedCount < pausedJobs.length) {
      targetJobs = await Job.find({
        _id: { $in: candidateIds },
        userId,
        status: 'queued',
      })
        .sort({ createdAt: 1, _id: 1 })
        .lean();
    }

    try {
      await mediaQueue.requeueMediaJobsBulk(targetJobs);
    } catch (queueErr) {
      const targetIds = targetJobs.map((j) => j._id);
      const targetIdStrings = targetJobs.map((j) => j._id.toString());
      await Job.updateMany(
        { _id: { $in: targetIds }, userId, status: 'queued' },
        {
          status: 'paused',
          downloadSpeed: null,
          eta: null,
          errorMessage: null,
        }
      ).catch(() => {});
      await mediaQueue.removeQueuedMediaJobsBulk(targetIdStrings).catch(() => {});
      await mediaQueue.clearJobProgressCachesBulk(targetIdStrings).catch(() => {});
      throw queueErr;
    }

    return res.status(200).json({
      success: true,
      resumedCount: targetJobs.length,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/jobs
 * Clears all jobs (and associated batch records) belonging to the authenticated user,
 * cancelling any queued/running downloads and optionally deleting finished files from disk.
 */
router.delete('/', async (req, res, next) => {
  try {
    const userId = getRequestUserId(req);
    const deleteFiles =
      String(req.query?.deleteFiles || '').toLowerCase() === 'true' ||
      req.body?.deleteFiles === true;

    const userJobs = await Job.find({ userId })
      .select('_id status filePath batchId')
      .lean();

    if (userJobs.length === 0) {
      return res.status(200).json({
        success: true,
        deletedCount: 0,
        cancelledActiveCount: 0,
        deletedFilesCount: 0,
      });
    }

    const allObjectIds = [];
    const allIdStrings = [];
    const allIdSet = new Set();
    const activeIds = [];
    const fenceableObjectIds = [];
    const filePathsToDelete = new Set();
    const batchIdSet = new Set();

    for (const job of userJobs) {
      const idStr = job._id.toString();
      allObjectIds.push(job._id);
      allIdStrings.push(idStr);
      allIdSet.add(idStr);
      if (ACTIVE_STATUSES.has(job.status)) {
        activeIds.push(idStr);
      }
      if (
        ACTIVE_STATUSES.has(job.status) ||
        job.status === 'paused' ||
        !job.filePath
      ) {
        fenceableObjectIds.push(job._id);
      }
      if (job.filePath && typeof job.filePath === 'string') {
        filePathsToDelete.add(job.filePath);
      }
      if (typeof job.batchId === 'string' && job.batchId.trim()) {
        batchIdSet.add(job.batchId.trim());
      }
    }

    await mediaQueue.removeQueuedMediaJobsBulk(allIdStrings);

    if (deleteFiles && fenceableObjectIds.length > 0) {
      await Job.updateMany(
        {
          _id: { $in: fenceableObjectIds },
          userId,
          status: { $in: ['queued', 'downloading', 'muxing', 'paused', 'failed'] },
        },
        { status: 'cancelled' }
      );

      const lateCompletedJobs = await Job.find({
        _id: { $in: fenceableObjectIds },
        userId,
        filePath: { $ne: null },
      })
        .select('_id filePath')
        .lean();

      for (const lateJob of lateCompletedJobs) {
        if (lateJob.filePath && typeof lateJob.filePath === 'string') {
          filePathsToDelete.add(lateJob.filePath);
        }
      }
    }

    const deleteResult = await Job.deleteMany({
      _id: { $in: allObjectIds },
      userId,
    });

    if (activeIds.length > 0) {
      await mediaQueue.publishJobControl({
        action: 'cancel-many',
        jobIds: activeIds,
      });
    }

    await mediaQueue.clearJobProgressCachesBulk(allIdStrings).catch(() => {});

    const batchIds = Array.from(batchIdSet);
    if (batchIds.length > 0) {
      await Batch.deleteMany({ userId, batchId: { $in: batchIds } });
    }

    const downloadsDir = getDownloadsDir();
    try {
      const tmpDir = path.join(downloadsDir, '.mediavault-tmp');
      const tmpEntries = await fs.promises.readdir(tmpDir);
      await Promise.all(
        tmpEntries.map((entry) => {
          const dotIdx = entry.indexOf('.');
          if (dotIdx > 0 && allIdSet.has(entry.slice(0, dotIdx))) {
            return fs.promises.unlink(path.join(tmpDir, entry)).catch(() => {});
          }
          return Promise.resolve();
        })
      );
    } catch {
      // Ignore missing temp directory
    }

    let deletedFilesCount = 0;
    if (deleteFiles) {
      const candidateDirs = new Set();
      for (const rawFilePath of filePathsToDelete) {
        if (!rawFilePath || typeof rawFilePath !== 'string') {
          continue;
        }
        const resolvedPath = path.resolve(rawFilePath);
        if (!resolvedPath.startsWith(`${downloadsDir}${path.sep}`)) {
          continue;
        }
        try {
          await fs.promises.unlink(resolvedPath);
          deletedFilesCount += 1;
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            console.error(`Failed to delete file ${resolvedPath}:`, err.message);
          }
        }

        const parentDir = path.dirname(resolvedPath);
        if (
          parentDir !== downloadsDir &&
          parentDir.startsWith(`${downloadsDir}${path.sep}`) &&
          path.basename(parentDir) !== '.mediavault-tmp'
        ) {
          candidateDirs.add(parentDir);
        }
      }

      if (candidateDirs.size > 0) {
        await Promise.all(
          Array.from(candidateDirs).map((dir) =>
            fs.promises.rmdir(dir).catch(() => {})
          )
        );
      }
    }

    return res.status(200).json({
      success: true,
      deletedCount: deleteResult?.deletedCount ?? userJobs.length,
      cancelledActiveCount: activeIds.length,
      deletedFilesCount,
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
    const expiredJobs = await Job.find({ userId, status: 'expired' })
      .select('batchId')
      .lean();
    const affectedBatchIds = Array.from(
      new Set(expiredJobs.map((job) => job.batchId).filter(Boolean))
    );

    const result = await Job.deleteMany({ userId, status: 'expired' });
    if (affectedBatchIds.length > 0) {
      await Promise.all(
        affectedBatchIds.map((batchId) => updateBatchRollup(batchId))
      );
    }

    return res.status(200).json({
      success: true,
      deletedCount: result?.deletedCount || 0,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/jobs/:id/pause
 * Pauses a queued or active download job while retaining partial files on disk.
 */
router.post('/:id/pause', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    const userId = getRequestUserId(req);
    const job = await Job.findOne({ _id: id, userId });
    if (!job) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    if (job.status === 'paused') {
      return res.status(200).json({ success: true, id, status: 'paused' });
    }

    if (!['queued', 'downloading', 'muxing'].includes(job.status)) {
      throw new AppError(
        409,
        'INVALID_JOB_STATE',
        `Cannot pause a job in "${job.status}" state.`
      );
    }

    const previousStatus = job.status;
    const updateResult = await Job.updateOne(
      { _id: job._id, userId, status: previousStatus },
      {
        status: 'paused',
        downloadSpeed: null,
        eta: null,
        errorMessage: null,
      }
    );
    if ((updateResult?.matchedCount ?? updateResult?.modifiedCount ?? 0) === 0) {
      throw new AppError(
        409,
        'INVALID_JOB_STATE',
        'Job state changed concurrently; cannot pause.'
      );
    }

    if (previousStatus === 'queued') {
      await mediaQueue.removeQueuedMediaJob(id);
    }
    await mediaQueue.clearJobProgressCache(id).catch(() => {});

    if (previousStatus === 'downloading' || previousStatus === 'muxing') {
      await mediaQueue.publishJobControl({ action: 'pause', jobId: id });
    }

    return res.status(200).json({
      success: true,
      id,
      status: 'paused',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/jobs/:id/resume
 * Resumes a paused job from its preserved partial download via `yt-dlp --continue`.
 */
router.post('/:id/resume', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    const userId = getRequestUserId(req);
    const job = await Job.findOne({ _id: id, userId });
    if (!job) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    if (job.status !== 'paused') {
      throw new AppError(
        409,
        'INVALID_JOB_STATE',
        `Only paused jobs can be resumed (current status: "${job.status}").`
      );
    }

    await assertSufficientDiskSpace(getDownloadsDir());
    if (job.useCookies) {
      await resolveCookieFile(job.platform);
    }

    const updateResult = await Job.updateOne(
      { _id: job._id, userId, status: 'paused' },
      {
        status: 'queued',
        downloadSpeed: null,
        eta: null,
        errorMessage: null,
      }
    );
    if ((updateResult?.matchedCount ?? updateResult?.modifiedCount ?? 0) === 0) {
      throw new AppError(
        409,
        'INVALID_JOB_STATE',
        'Job state changed concurrently; cannot resume.'
      );
    }

    try {
      await mediaQueue.requeueMediaJob(job);
    } catch (queueErr) {
      await Job.updateOne(
        { _id: job._id, userId, status: 'queued' },
        {
          status: 'paused',
          downloadSpeed: null,
          eta: null,
          errorMessage: null,
        }
      ).catch(() => {});
      await mediaQueue.clearJobProgressCache(id).catch(() => {});
      throw queueErr;
    }

    return res.status(202).json({
      success: true,
      id,
      status: 'queued',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/jobs/:id/retry
 * Retries a failed, paused, or stalled active download in-place while retaining `.part` files.
 */
router.post('/:id/retry', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    const userId = getRequestUserId(req);
    const job = await Job.findOne({ _id: id, userId });
    if (!job) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    if (!['failed', 'paused', 'downloading', 'muxing', 'queued'].includes(job.status)) {
      throw new AppError(
        409,
        'INVALID_JOB_STATE',
        `Cannot retry a job in "${job.status}" state.`
      );
    }

    const nextUseCookies =
      req.body && req.body.useCookies === true ? true : Boolean(job.useCookies);

    await assertSufficientDiskSpace(getDownloadsDir());
    if (nextUseCookies) {
      await resolveCookieFile(job.platform);
    }

    const previousStatus = job.status;
    const previousUseCookies = Boolean(job.useCookies);
    const previousErrorMessage = job.errorMessage || null;
    const updateResult = await Job.updateOne(
      { _id: job._id, userId, status: previousStatus },
      {
        status: 'queued',
        useCookies: nextUseCookies,
        downloadSpeed: null,
        eta: null,
        errorMessage: null,
      }
    );
    if ((updateResult?.matchedCount ?? updateResult?.modifiedCount ?? 0) === 0) {
      throw new AppError(
        409,
        'INVALID_JOB_STATE',
        'Job state changed concurrently; cannot retry.'
      );
    }

    let delayMs = 0;

    try {
      if (previousStatus === 'downloading' || previousStatus === 'muxing') {
        await mediaQueue.publishJobControl({ action: 'cancel-for-retry', jobId: id });
        delayMs = 600;
      } else if (previousStatus === 'queued') {
        await mediaQueue.removeQueuedMediaJob(id);
      }

      await mediaQueue.clearJobProgressCache(id).catch(() => {});
      await mediaQueue.requeueMediaJob(job, { delayMs });
    } catch (queueErr) {
      const rollbackStatus =
        previousStatus === 'paused' ? 'paused' : 'failed';
      const rollbackErrorMessage =
        previousStatus === 'paused'
          ? null
          : previousStatus === 'failed'
            ? previousErrorMessage || `Failed to requeue job: ${queueErr.message}`
            : `Failed to requeue job: ${queueErr.message}`;

      await Job.updateOne(
        { _id: job._id, userId, status: 'queued' },
        {
          status: rollbackStatus,
          useCookies: previousUseCookies,
          downloadSpeed: null,
          eta: null,
          errorMessage: rollbackErrorMessage,
        }
      ).catch(() => {});
      await mediaQueue.clearJobProgressCache(id).catch(() => {});
      if (job.batchId) {
        await updateBatchRollup(job.batchId).catch(() => {});
      }
      throw queueErr;
    }

    if (job.batchId) {
      await updateBatchRollup(job.batchId);
    }

    return res.status(202).json({
      success: true,
      id,
      status: 'queued',
      useCookies: nextUseCookies,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/jobs/:id
 * Cancels/removes a queued, ready, failed, or expired job and deletes its saved media file from disk.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    const userId = getRequestUserId(req);
    const job = await Job.findOne({ _id: id, userId });
    if (!job) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Requested job ID does not exist.');
    }

    if (job.status === 'downloading' || job.status === 'muxing') {
      throw new AppError(
        409,
        'JOB_ACTIVE',
        'Cannot delete a job while it is actively downloading or muxing.'
      );
    }

    if (job.status === 'queued') {
      await mediaQueue.removeQueuedMediaJob(id);
    }

    const downloadsDir = getDownloadsDir();
    try {
      const tmpDir = path.join(downloadsDir, '.mediavault-tmp');
      const tmpEntries = await fs.promises.readdir(tmpDir);
      await Promise.all(
        tmpEntries
          .filter((entry) => entry.startsWith(`${id}.`))
          .map((entry) => fs.promises.unlink(path.join(tmpDir, entry)).catch(() => {}))
      );
    } catch {
      // Ignore missing temp directory
    }

    let fileDeleted = false;
    if (job.filePath && typeof job.filePath === 'string') {
      const resolvedPath = path.resolve(job.filePath);
      if (resolvedPath.startsWith(`${downloadsDir}${path.sep}`)) {
        try {
          await fs.promises.unlink(resolvedPath);
          fileDeleted = true;
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            throw err;
          }
        }

        const parentDir = path.dirname(resolvedPath);
        if (
          parentDir !== downloadsDir &&
          parentDir.startsWith(`${downloadsDir}${path.sep}`) &&
          path.basename(parentDir) !== '.mediavault-tmp'
        ) {
          await fs.promises.rmdir(parentDir).catch(() => {});
        }
      }
    }

    await Job.deleteOne({ _id: job._id });
    await mediaQueue.clearJobProgressCache(id).catch(() => {});
    if (job.batchId) {
      await updateBatchRollup(job.batchId);
    }

    return res.status(200).json({
      success: true,
      deletedId: id,
      fileDeleted,
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
    let totalSizeBytes = job.totalSizeBytes || job.fileSizeBytes || 0;

    if (ACTIVE_STATUSES.has(status)) {
      const cached = await mediaQueue.getJobProgressCache(id).catch(() => null);
      if (cached) {
        if (cached.status && VALID_STATUSES.has(cached.status)) {
          status = cached.status;
        }
        if (typeof cached.progress === 'number' && Number.isFinite(cached.progress)) {
          progress = Math.max(progress || 0, cached.progress);
        }
        downloadSpeed = cached.downloadSpeed ?? downloadSpeed;
        eta = cached.eta ?? eta;
        if (typeof cached.totalSizeBytes === 'number' && Number.isFinite(cached.totalSizeBytes)) {
          totalSizeBytes = Math.max(totalSizeBytes, cached.totalSizeBytes);
        }
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
      totalSizeBytes,
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
      if (job.batchId) {
        await updateBatchRollup(job.batchId).catch(() => {});
      }
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
