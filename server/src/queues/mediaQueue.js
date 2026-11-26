const IORedis = require('ioredis');
const { Queue } = require('bullmq');

const MEDIA_QUEUE_NAME = 'media-downloads';
const JOB_CONTROL_CHANNEL = 'mediavault:job-control';
const PROGRESS_TTL_SECONDS = 3600;

let queueInstance = null;
let queueConnection = null;
let progressRedis = null;

/**
 * Creates a Redis client configured for BullMQ compatibility.
 *
 * @returns {IORedis}
 */
function createRedisConnection() {
  const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
  const client = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  client.on('error', (err) => {
    console.error('Redis connection error:', err.message);
  });

  return client;
}

function getMediaQueue() {
  if (!queueInstance) {
    queueConnection = createRedisConnection();
    queueInstance = new Queue(MEDIA_QUEUE_NAME, {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queueInstance;
}

function getProgressRedis() {
  if (!progressRedis) {
    progressRedis = createRedisConnection();
  }
  return progressRedis;
}

/**
 * Enqueues a Mongoose Job record onto BullMQ.
 *
 * @param {{ _id: import('mongoose').Types.ObjectId | string }} jobDoc
 */
async function enqueueMediaJob(jobDoc) {
  const jobId = jobDoc._id.toString();
  return getMediaQueue().add(
    'download-media',
    { jobId },
    { jobId }
  );
}

/**
 * Enqueues multiple Mongoose Job records onto BullMQ in chunks of 250.
 *
 * @param {Array<{ _id: import('mongoose').Types.ObjectId | string }>} jobDocs
 */
async function enqueueMediaJobsBulk(jobDocs) {
  if (!Array.isArray(jobDocs) || jobDocs.length === 0) {
    return [];
  }

  const queue = getMediaQueue();
  const results = [];
  const CHUNK_SIZE = 250;

  for (let i = 0; i < jobDocs.length; i += CHUNK_SIZE) {
    const slice = jobDocs.slice(i, i + CHUNK_SIZE).map((doc) => {
      const jobId = doc._id.toString();
      return {
        name: 'download-media',
        data: { jobId },
        opts: { jobId },
      };
    });
    const added = await queue.addBulk(slice);
    results.push(...added);
  }

  return results;
}

/**
 * Best-effort removal of a waiting/delayed job from BullMQ.
 *
 * @param {string} jobId
 */
async function removeQueuedMediaJob(jobId) {
  try {
    const bullJob = await getMediaQueue().getJob(jobId);
    if (bullJob) {
      await bullJob.remove().catch(() => {});
    }
  } catch {
    // Best-effort cleanup only
  }
}

/**
 * Best-effort removal of multiple waiting/delayed/prioritized jobs from BullMQ.
 *
 * @param {string[]} jobIds
 */
async function removeQueuedMediaJobsBulk(jobIds) {
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return;
  }

  const normalizedIds = jobIds.map((id) => String(id));
  const idSet = new Set(normalizedIds);
  const CHUNK_SIZE = 50;

  try {
    const queue = getMediaQueue();
    const pending = await queue.getJobs(['waiting', 'delayed', 'prioritized'], 0, -1);
    const matching = pending.filter(
      (bullJob) =>
        bullJob &&
        (idSet.has(String(bullJob.id)) || idSet.has(String(bullJob.data?.jobId)))
    );

    for (let i = 0; i < matching.length; i += CHUNK_SIZE) {
      const slice = matching.slice(i, i + CHUNK_SIZE);
      await Promise.all(slice.map((bullJob) => bullJob.remove().catch(() => {})));
    }
  } catch {
    for (let i = 0; i < normalizedIds.length; i += CHUNK_SIZE) {
      const slice = normalizedIds.slice(i, i + CHUNK_SIZE);
      await Promise.all(slice.map((id) => removeQueuedMediaJob(id)));
    }
  }
}

/**
 * Publishes an immediate pause / retry / cancel control signal to active worker instances.
 *
 * @param {{ action: 'pause' | 'pause-many' | 'cancel-for-retry' | 'cancel' | 'cancel-many', jobId?: string, jobIds?: string[] }} payload
 */
async function publishJobControl(payload) {
  const redis = getProgressRedis();
  await redis.publish(JOB_CONTROL_CHANNEL, JSON.stringify(payload));
}

/**
 * Requeues a single paused/failed/stalled Job cleanly on BullMQ by clearing any prior
 * retained job ID (or using a delayed unique run ID if the previous run is still winding down).
 *
 * @param {{ _id: import('mongoose').Types.ObjectId | string }} jobDoc
 * @param {{ delayMs?: number }} [options]
 */
async function requeueMediaJob(jobDoc, { delayMs = 0 } = {}) {
  const jobId = jobDoc._id.toString();
  const queue = getMediaQueue();
  let bullJobId = jobId;

  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      await existing.remove();
    }
  } catch {
    bullJobId = `${jobId}-r-${Date.now()}`;
  }

  const effectiveDelay =
    bullJobId !== jobId ? Math.max(500, delayMs) : Math.max(0, delayMs);

  return queue.add(
    'download-media',
    { jobId },
    {
      jobId: bullJobId,
      ...(effectiveDelay > 0 ? { delay: effectiveDelay } : {}),
    }
  );
}

/**
 * Requeues multiple paused Job documents cleanly in chunks of 50.
 *
 * @param {Array<{ _id: import('mongoose').Types.ObjectId | string }>} jobDocs
 */
async function requeueMediaJobsBulk(jobDocs) {
  if (!Array.isArray(jobDocs) || jobDocs.length === 0) {
    return [];
  }

  const results = [];
  const CHUNK_SIZE = 50;
  for (let i = 0; i < jobDocs.length; i += CHUNK_SIZE) {
    const slice = jobDocs.slice(i, i + CHUNK_SIZE);
    const added = await Promise.all(slice.map((doc) => requeueMediaJob(doc)));
    results.push(...added);
  }
  return results;
}

/**
 * Stores volatile live progress updates in Redis to minimize MongoDB write load.
 *
 * @param {string} jobId
 * @param {{ status?: string, progress?: number, downloadSpeed?: string | null, eta?: string | null, totalSizeBytes?: number }} payload
 */
async function setJobProgressCache(jobId, payload) {
  const redis = getProgressRedis();
  const key = `progress:job:${jobId}`;
  const fields = {
    status: String(payload.status || 'downloading'),
    progress: String(Number(payload.progress ?? 0)),
    downloadSpeed: payload.downloadSpeed ? String(payload.downloadSpeed) : '',
    eta: payload.eta ? String(payload.eta) : '',
    totalSizeBytes: String(Math.max(0, Math.round(Number(payload.totalSizeBytes || 0)))),
  };
  await redis.hset(key, fields);
  await redis.expire(key, PROGRESS_TTL_SECONDS);
}

/**
 * Reads cached live progress for an active job from Redis.
 *
 * @param {string} jobId
 */
async function getJobProgressCache(jobId) {
  const redis = getProgressRedis();
  const data = await redis.hgetall(`progress:job:${jobId}`);
  if (!data || Object.keys(data).length === 0) {
    return null;
  }
  return {
    status: data.status || null,
    progress: data.progress !== undefined ? Number(data.progress) : null,
    downloadSpeed: data.downloadSpeed || null,
    eta: data.eta || null,
    totalSizeBytes: data.totalSizeBytes !== undefined ? Number(data.totalSizeBytes) || 0 : 0,
  };
}

/**
 * Removes cached live progress once a job finishes or fails.
 *
 * @param {string} jobId
 */
async function clearJobProgressCache(jobId) {
  const redis = getProgressRedis();
  await redis.del(`progress:job:${jobId}`);
}

/**
 * Removes cached live progress keys for multiple jobs in chunks of 200.
 *
 * @param {string[]} jobIds
 */
async function clearJobProgressCachesBulk(jobIds) {
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return;
  }

  const redis = getProgressRedis();
  const keys = jobIds.map((id) => `progress:job:${String(id)}`);
  const CHUNK_SIZE = 200;

  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    await redis.del(...keys.slice(i, i + CHUNK_SIZE));
  }
}

/**
 * Gracefully closes queue and Redis connections.
 */
async function closeMediaQueue() {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
  if (queueConnection) {
    await queueConnection.quit();
    queueConnection = null;
  }
  if (progressRedis) {
    await progressRedis.quit();
    progressRedis = null;
  }
}

module.exports = {
  MEDIA_QUEUE_NAME,
  JOB_CONTROL_CHANNEL,
  createRedisConnection,
  getMediaQueue,
  enqueueMediaJob,
  enqueueMediaJobsBulk,
  removeQueuedMediaJob,
  removeQueuedMediaJobsBulk,
  publishJobControl,
  requeueMediaJob,
  requeueMediaJobsBulk,
  setJobProgressCache,
  getJobProgressCache,
  clearJobProgressCache,
  clearJobProgressCachesBulk,
  closeMediaQueue,
};
