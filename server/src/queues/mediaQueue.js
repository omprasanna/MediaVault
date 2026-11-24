const IORedis = require('ioredis');
const { Queue } = require('bullmq');

const MEDIA_QUEUE_NAME = 'media-downloads';
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
 * Stores volatile live progress updates in Redis to minimize MongoDB write load.
 *
 * @param {string} jobId
 * @param {{ status?: string, progress?: number, downloadSpeed?: string | null, eta?: string | null }} payload
 */
async function setJobProgressCache(jobId, payload) {
  const redis = getProgressRedis();
  const key = `progress:job:${jobId}`;
  const fields = {
    status: String(payload.status || 'downloading'),
    progress: String(Number(payload.progress ?? 0)),
    downloadSpeed: payload.downloadSpeed ? String(payload.downloadSpeed) : '',
    eta: payload.eta ? String(payload.eta) : '',
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
  createRedisConnection,
  getMediaQueue,
  enqueueMediaJob,
  setJobProgressCache,
  getJobProgressCache,
  clearJobProgressCache,
  closeMediaQueue,
};
