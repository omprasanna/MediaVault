const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const Batch = require('../src/models/Batch');
const Job = require('../src/models/Job');
const User = require('../src/models/User');
const mediaQueue = require('../src/queues/mediaQueue');
const {
  getJwtSecret,
  parseDurationToMs,
  requireAuth,
} = require('../src/middleware/auth');
const authRouter = require('../src/routes/auth');
const jobsRouter = require('../src/routes/jobs');
const { updateBatchRollup } = require('../src/utils/batchRollup');
const { validateNetscapeCookies } = require('../src/utils/cookieValidator');
const { mapInspectResponse } = require('../src/utils/formatMapper');
const { processJob, runStorageCleanup } = require('../src/worker');

test('validateNetscapeCookies accepts valid Netscape & HttpOnly lines and normalizes LF', () => {
  const raw =
    '\uFEFF# Netscape HTTP Cookie File\r\n' +
    '# comment line\r\n' +
    '.youtube.com\tTRUE\t/\tTRUE\t1799999999\tVISITOR_INFO1_LIVE\tabc123\r\n' +
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1799999999\tHSID\txyz789\r\n';

  const res = validateNetscapeCookies(raw);
  assert.equal(res.cookieCount, 2);
  assert.ok(res.normalizedContent.startsWith('# Netscape HTTP Cookie File\n'));
  assert.ok(!res.normalizedContent.includes('\r'));
  assert.ok(res.normalizedContent.includes('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1799999999\tHSID\txyz789'));
});

test('validateNetscapeCookies rejects malformed Netscape cookie payloads', () => {
  const invalidPayloads = [
    '',
    'youtube.com\tTRUE\t/\tFALSE\t1799999999\tSID\t123', // missing header
    '# Netscape HTTP Cookie File\n', // empty cookie list
    '# Netscape HTTP Cookie File\n.youtube.com TRUE / FALSE 1799999999 SID 123', // spaces instead of tabs
    '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\tnotanumber\tSID\t123', // bad expiration
    '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\tno-slash\tFALSE\t1799999999\tSID\t123', // bad path
  ];

  for (const bad of invalidPayloads) {
    assert.throws(() => validateNetscapeCookies(bad), {
      code: 'INVALID_COOKIE_FORMAT',
    });
  }
});

test('mapInspectResponse normalizes playlist entries with id, title, creator, duration, thumbnail, url', () => {
  const rawPlaylist = {
    _type: 'playlist',
    title: 'Sample Mix',
    uploader: 'Channel Fallback',
    webpage_url: 'https://www.youtube.com/playlist?list=PL123',
    entries: [
      {
        id: 'vid1',
        title: 'First Track',
        uploader: 'Artist One',
        duration: 185,
        thumbnails: [{ url: 'https://i.ytimg.com/vi/vid1/hqdefault.jpg' }],
        url: 'https://www.youtube.com/watch?v=vid1',
      },
      {
        id: 'vid2',
        title: '[Deleted video]',
        availability: 'unavailable',
      },
      {
        id: 'vid3',
        title: 'Second Track',
        channel: 'Artist Two',
        duration: 210,
      },
    ],
  };

  const mapped = mapInspectResponse(rawPlaylist, {
    platform: 'youtube',
    sourceUrl: 'https://www.youtube.com/playlist?list=PL123',
  });

  assert.equal(mapped.isPlaylist, true);
  assert.equal(mapped.playlistTitle, 'Sample Mix');
  assert.equal(mapped.totalItems, 2);
  assert.deepEqual(mapped.items[0], {
    id: 'vid1',
    title: 'First Track',
    creator: 'Artist One',
    duration: 185,
    thumbnail: 'https://i.ytimg.com/vi/vid1/hqdefault.jpg',
    url: 'https://www.youtube.com/watch?v=vid1',
  });
  assert.equal(mapped.items[1].id, 'vid3');
  assert.equal(mapped.items[1].creator, 'Artist Two');
  assert.equal(mapped.items[1].url, 'https://www.youtube.com/watch?v=vid3');
  assert.equal(mapped.items[1].thumbnail, 'https://i.ytimg.com/vi/vid3/hqdefault.jpg');
});

test('parseDurationToMs parses standard JWT duration strings', () => {
  assert.equal(parseDurationToMs('7d'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseDurationToMs('24h'), 24 * 60 * 60 * 1000);
  assert.equal(parseDurationToMs('30m'), 30 * 60 * 1000);
  assert.equal(parseDurationToMs('60s'), 60 * 1000);
  assert.equal(parseDurationToMs('120'), 120 * 1000);
});

test('requireAuth rejects missing or invalid JWT cookies and attaches req.user when valid', async () => {
  const prevSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  const originalFindById = User.findById;

  try {
    let capturedErr = null;
    await requireAuth({ cookies: {} }, {}, (err) => {
      capturedErr = err;
    });
    assert.equal(capturedErr.statusCode, 401);
    assert.equal(capturedErr.code, 'UNAUTHORIZED');

    capturedErr = null;
    await requireAuth({ cookies: { jwt: 'invalid.jwt.token' } }, {}, (err) => {
      capturedErr = err;
    });
    assert.equal(capturedErr.statusCode, 401);

    User.findById = () => ({
      select: () => ({
        lean: async () => ({
          _id: { toString: () => '65b2d8e9f1a23c0012a45bc8' },
          email: 'admin@mediavault.local',
          role: 'admin',
        }),
      }),
    });

    const validToken = jwt.sign(
      { sub: '65b2d8e9f1a23c0012a45bc8', email: 'admin@mediavault.local', role: 'admin' },
      getJwtSecret(),
      { expiresIn: '1h' }
    );
    const req = { cookies: { jwt: validToken } };
    let nextErr;
    await requireAuth(req, {}, (err) => {
      nextErr = err;
    });
    assert.equal(nextErr, undefined);
    assert.deepEqual(req.user, {
      id: '65b2d8e9f1a23c0012a45bc8',
      email: 'admin@mediavault.local',
      role: 'admin',
    });
  } finally {
    User.findById = originalFindById;
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  }
});

test('POST /api/auth/register returns 403 REGISTRATION_DISABLED when ALLOW_REGISTRATION=false', async () => {
  const prev = process.env.ALLOW_REGISTRATION;
  process.env.ALLOW_REGISTRATION = 'false';

  try {
    const layer = authRouter.stack.find(
      (l) => l.route && l.route.path === '/register' && l.route.methods.post
    );
    assert.ok(layer, 'Expected POST /register route handler');
    const handler = layer.route.stack[0].handle;

    let capturedErr = null;
    await handler(
      { body: { email: 'user@example.com', password: 'Password123!' } },
      {},
      (err) => {
        capturedErr = err;
      }
    );
    assert.equal(capturedErr.statusCode, 403);
    assert.equal(capturedErr.code, 'REGISTRATION_DISABLED');
  } finally {
    if (prev === undefined) delete process.env.ALLOW_REGISTRATION;
    else process.env.ALLOW_REGISTRATION = prev;
  }
});

test('POST /api/jobs accepts full playlist batches (>50 items, 75 items) when MAX_BATCH_ITEMS is 0', async () => {
  const prevMax = process.env.MAX_BATCH_ITEMS;
  delete process.env.MAX_BATCH_ITEMS;

  const origLookup = dns.promises.lookup;
  const origStatfs = fs.promises.statfs;
  const origBatchCreate = Batch.create;
  const origJobInsertMany = Job.insertMany;
  const origEnqueueBulk = mediaQueue.enqueueMediaJobsBulk;

  let enqueuedCount = 0;

  dns.promises.lookup = async () => [{ address: '142.250.190.46', family: 4 }];
  fs.promises.statfs = async () => ({ bavail: 1000000, bsize: 4096 * 1024 });
  Batch.create = async (doc) => doc;
  Job.insertMany = async (docs) =>
    docs.map((doc, idx) => ({
      ...doc,
      _id: { toString: () => `65b2d8e9f1a23c0012a4${String(idx).padStart(4, '0')}` },
    }));
  mediaQueue.enqueueMediaJobsBulk = async (docs) => {
    enqueuedCount = docs.length;
    return [];
  };

  try {
    const layer = jobsRouter.stack.find(
      (l) => l.route && l.route.path === '/' && l.route.methods.post
    );
    assert.ok(layer, 'Expected POST /api/jobs handler');
    const handler = layer.route.stack[0].handle;

    const items = Array.from({ length: 75 }, (_, idx) => ({
      sourceUrl: `https://www.youtube.com/watch?v=track_${idx}`,
      title: `Track ${idx + 1}`,
      duration: 180,
      mode: 'audio',
      container: 'mp3',
      formatSelector: 'bestaudio/best',
    }));

    let responseStatus = null;
    let responsePayload = null;
    const req = {
      user: { id: '65b2d8e9f1a23c0012a45bc8', email: 'admin@mediavault.local', role: 'admin' },
      body: {
        playlistTitle: 'Large Mix 75',
        playlistUrl: 'https://www.youtube.com/playlist?list=PLlarge75',
        useCookies: false,
        items,
      },
    };
    const res = {
      status(code) {
        responseStatus = code;
        return {
          json(payload) {
            responsePayload = payload;
            return res;
          },
        };
      },
    };

    let capturedErr = null;
    await handler(req, res, (err) => {
      capturedErr = err;
    });

    assert.equal(capturedErr, null);
    assert.equal(responseStatus, 202);
    assert.equal(responsePayload.success, true);
    assert.ok(responsePayload.batchId);
    assert.equal(responsePayload.jobIds.length, 75);
    assert.equal(enqueuedCount, 75);
  } finally {
    if (prevMax === undefined) delete process.env.MAX_BATCH_ITEMS;
    else process.env.MAX_BATCH_ITEMS = prevMax;
    dns.promises.lookup = origLookup;
    fs.promises.statfs = origStatfs;
    Batch.create = origBatchCreate;
    Job.insertMany = origJobInsertMany;
    mediaQueue.enqueueMediaJobsBulk = origEnqueueBulk;
  }
});

function findJobRouteHandler(method, routePath) {
  const layer = jobsRouter.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} /api/jobs${routePath} route handler`);
  return layer.route.stack[0].handle;
}

function createMockResponse() {
  const result = { statusCode: null, payload: null };
  const res = {
    status(code) {
      result.statusCode = code;
      return {
        json(body) {
          result.payload = body;
          return res;
        },
      };
    },
  };
  return { res, result };
}

test('POST /api/jobs/:id/pause and pause-all pause active/queued jobs and signal running workers', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const downloadingId = '65b2d8e9f1a23c0012a40001';
  const queuedId = '65b2d8e9f1a23c0012a40002';

  const origFindOne = Job.findOne;
  const origFind = Job.find;
  const origUpdateOne = Job.updateOne;
  const origUpdateMany = Job.updateMany;
  const origRemoveQueued = mediaQueue.removeQueuedMediaJob;
  const origPublish = mediaQueue.publishJobControl;
  const origClearCache = mediaQueue.clearJobProgressCache;

  const publishedPayloads = [];
  const removedIds = [];
  const updatedStatuses = [];

  Job.findOne = async ({ _id }) =>
    _id === downloadingId
      ? { _id: { toString: () => downloadingId }, userId, status: 'downloading' }
      : null;
  Job.updateOne = async (_query, update) => {
    updatedStatuses.push(update.status);
    return { modifiedCount: 1 };
  };
  Job.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: { toString: () => downloadingId }, status: 'downloading' },
        { _id: { toString: () => queuedId }, status: 'queued' },
      ],
    }),
  });
  Job.updateMany = async (_query, update) => {
    updatedStatuses.push(`many:${update.status}`);
    return { modifiedCount: 2 };
  };
  mediaQueue.removeQueuedMediaJob = async (id) => {
    removedIds.push(id);
  };
  mediaQueue.publishJobControl = async (payload) => {
    publishedPayloads.push(payload);
  };
  mediaQueue.clearJobProgressCache = async () => {};

  try {
    const pauseHandler = findJobRouteHandler('post', '/:id/pause');
    const pauseAllHandler = findJobRouteHandler('post', '/pause-all');

    const { res: r1, result: res1 } = createMockResponse();
    let err1 = null;
    await pauseHandler(
      { params: { id: downloadingId }, user: { id: userId } },
      r1,
      (err) => {
        err1 = err;
      }
    );
    assert.equal(err1, null);
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.payload.status, 'paused');
    assert.deepEqual(publishedPayloads[0], { action: 'pause', jobId: downloadingId });

    const { res: r2, result: res2 } = createMockResponse();
    let err2 = null;
    await pauseAllHandler({ user: { id: userId } }, r2, (err) => {
      err2 = err;
    });
    assert.equal(err2, null);
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.payload.pausedCount, 2);
    assert.deepEqual(removedIds, [queuedId]);
    assert.deepEqual(publishedPayloads[1], {
      action: 'pause-many',
      jobIds: [downloadingId],
    });
    assert.ok(updatedStatuses.includes('paused'));
    assert.ok(updatedStatuses.includes('many:paused'));
  } finally {
    Job.findOne = origFindOne;
    Job.find = origFind;
    Job.updateOne = origUpdateOne;
    Job.updateMany = origUpdateMany;
    mediaQueue.removeQueuedMediaJob = origRemoveQueued;
    mediaQueue.publishJobControl = origPublish;
    mediaQueue.clearJobProgressCache = origClearCache;
  }
});

test('POST /api/jobs/:id/resume and retry requeue paused, failed, and stalled downloading jobs in-place', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const pausedId = '65b2d8e9f1a23c0012a40011';
  const stalledId = '65b2d8e9f1a23c0012a40012';
  const failedId = '65b2d8e9f1a23c0012a40013';

  const origFindOne = Job.findOne;
  const origUpdateOne = Job.updateOne;
  const origStatfs = fs.promises.statfs;
  const origRequeue = mediaQueue.requeueMediaJob;
  const origPublish = mediaQueue.publishJobControl;
  const origClearCache = mediaQueue.clearJobProgressCache;

  const requeueCalls = [];
  const publishedPayloads = [];

  Job.findOne = async ({ _id }) => {
    if (_id === pausedId) {
      return {
        _id: { toString: () => pausedId },
        userId,
        platform: 'youtube',
        useCookies: false,
        status: 'paused',
        progress: 62,
      };
    }
    if (_id === stalledId) {
      return {
        _id: { toString: () => stalledId },
        userId,
        platform: 'youtube',
        useCookies: false,
        status: 'downloading',
        progress: 62,
      };
    }
    if (_id === failedId) {
      return {
        _id: { toString: () => failedId },
        userId,
        platform: 'youtube',
        useCookies: false,
        status: 'failed',
        progress: 40,
      };
    }
    return null;
  };
  Job.updateOne = async () => ({ modifiedCount: 1 });
  fs.promises.statfs = async () => ({ bavail: 1000000, bsize: 4096 * 1024 });
  mediaQueue.requeueMediaJob = async (doc, opts = {}) => {
    requeueCalls.push({ id: doc._id.toString(), delayMs: opts.delayMs || 0 });
  };
  mediaQueue.publishJobControl = async (payload) => {
    publishedPayloads.push(payload);
  };
  mediaQueue.clearJobProgressCache = async () => {};

  try {
    const resumeHandler = findJobRouteHandler('post', '/:id/resume');
    const retryHandler = findJobRouteHandler('post', '/:id/retry');

    const { res: resResume, result: outResume } = createMockResponse();
    let errResume = null;
    await resumeHandler({ params: { id: pausedId }, user: { id: userId } }, resResume, (err) => {
      errResume = err;
    });
    assert.equal(errResume, null);
    assert.equal(outResume.statusCode, 202);
    assert.equal(outResume.payload.status, 'queued');

    const { res: resStalled, result: outStalled } = createMockResponse();
    let errStalled = null;
    await retryHandler(
      { params: { id: stalledId }, body: {}, user: { id: userId } },
      resStalled,
      (err) => {
        errStalled = err;
      }
    );
    assert.equal(errStalled, null);
    assert.equal(outStalled.statusCode, 202);
    assert.equal(outStalled.payload.status, 'queued');

    const { res: resFailed, result: outFailed } = createMockResponse();
    let errFailed = null;
    await retryHandler(
      { params: { id: failedId }, body: {}, user: { id: userId } },
      resFailed,
      (err) => {
        errFailed = err;
      }
    );
    assert.equal(errFailed, null);
    assert.equal(outFailed.statusCode, 202);
    assert.equal(outFailed.payload.status, 'queued');

    assert.deepEqual(publishedPayloads, [
      { action: 'cancel-for-retry', jobId: stalledId },
    ]);
    assert.deepEqual(requeueCalls, [
      { id: pausedId, delayMs: 0 },
      { id: stalledId, delayMs: 600 },
      { id: failedId, delayMs: 0 },
    ]);
  } finally {
    Job.findOne = origFindOne;
    Job.updateOne = origUpdateOne;
    fs.promises.statfs = origStatfs;
    mediaQueue.requeueMediaJob = origRequeue;
    mediaQueue.publishJobControl = origPublish;
    mediaQueue.clearJobProgressCache = origClearCache;
  }
});

test('DELETE /api/jobs returns zero counts when queue is already empty', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const origFind = Job.find;
  const origDeleteMany = Job.deleteMany;
  const origBatchDeleteMany = Batch.deleteMany;
  const origRemoveBulk = mediaQueue.removeQueuedMediaJobsBulk;
  const origPublish = mediaQueue.publishJobControl;
  const origClearBulk = mediaQueue.clearJobProgressCachesBulk;

  let deleteManyCalled = false;
  let publishCalled = false;

  Job.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });
  Job.deleteMany = async () => {
    deleteManyCalled = true;
    return { deletedCount: 0 };
  };
  Batch.deleteMany = async () => ({ deletedCount: 0 });
  mediaQueue.removeQueuedMediaJobsBulk = async () => {};
  mediaQueue.publishJobControl = async () => {
    publishCalled = true;
  };
  mediaQueue.clearJobProgressCachesBulk = async () => {};

  try {
    const clearHandler = findJobRouteHandler('delete', '/');
    const { res, result } = createMockResponse();
    let capturedErr = null;
    await clearHandler({ user: { id: userId }, query: {} }, res, (err) => {
      capturedErr = err;
    });

    assert.equal(capturedErr, null);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, {
      success: true,
      deletedCount: 0,
      cancelledActiveCount: 0,
      deletedFilesCount: 0,
    });
    assert.equal(deleteManyCalled, false);
    assert.equal(publishCalled, false);
  } finally {
    Job.find = origFind;
    Job.deleteMany = origDeleteMany;
    Batch.deleteMany = origBatchDeleteMany;
    mediaQueue.removeQueuedMediaJobsBulk = origRemoveBulk;
    mediaQueue.publishJobControl = origPublish;
    mediaQueue.clearJobProgressCachesBulk = origClearBulk;
  }
});

test('DELETE /api/jobs clears all jobs, cancels active downloads, cleans temp parts, and preserves completed files by default', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const prevDownloadsDir = process.env.DOWNLOADS_DIR;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-clear-default-'));
  const tmpDir = path.join(tempRoot, '.mediavault-tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  process.env.DOWNLOADS_DIR = tempRoot;

  const downloadingId = '65b2d8e9f1a23c0012a41001';
  const muxingId = '65b2d8e9f1a23c0012a41002';
  const queuedId = '65b2d8e9f1a23c0012a41003';
  const pausedId = '65b2d8e9f1a23c0012a41004';
  const readyId = '65b2d8e9f1a23c0012a41005';
  const failedId = '65b2d8e9f1a23c0012a41006';
  const expiredId = '65b2d8e9f1a23c0012a41007';

  const readyFile = path.join(tempRoot, 'Completed Video.mp4');
  const matchingTmp = path.join(tmpDir, `${downloadingId}.mp4.part`);
  const matchingPausedTmp = path.join(tmpDir, `${pausedId}.webm.part`);
  const unrelatedTmp = path.join(tmpDir, 'other-user-job.mp4.part');
  await fs.promises.writeFile(readyFile, 'video-bytes');
  await fs.promises.writeFile(matchingTmp, 'partial-bytes');
  await fs.promises.writeFile(matchingPausedTmp, 'paused-bytes');
  await fs.promises.writeFile(unrelatedTmp, 'other-bytes');

  const origFind = Job.find;
  const origDeleteMany = Job.deleteMany;
  const origBatchDeleteMany = Batch.deleteMany;
  const origRemoveBulk = mediaQueue.removeQueuedMediaJobsBulk;
  const origPublish = mediaQueue.publishJobControl;
  const origClearBulk = mediaQueue.clearJobProgressCachesBulk;

  let removedQueueIds = [];
  let deletedJobQuery = null;
  let deletedBatchQuery = null;
  let clearedCacheIds = [];
  const publishedPayloads = [];

  const mockJobs = [
    { _id: { toString: () => downloadingId }, status: 'downloading', batchId: 'batch-1' },
    { _id: { toString: () => muxingId }, status: 'muxing', batchId: 'batch-1' },
    { _id: { toString: () => queuedId }, status: 'queued', batchId: null },
    { _id: { toString: () => pausedId }, status: 'paused', batchId: 'batch-2' },
    { _id: { toString: () => readyId }, status: 'ready', filePath: readyFile, batchId: null },
    { _id: { toString: () => failedId }, status: 'failed', batchId: null },
    { _id: { toString: () => expiredId }, status: 'expired', batchId: null },
  ];

  Job.find = (query) => {
    assert.equal(query.userId, userId);
    return {
      select: () => ({
        lean: async () => mockJobs,
      }),
    };
  };
  Job.deleteMany = async (query) => {
    deletedJobQuery = query;
    return { deletedCount: mockJobs.length };
  };
  Batch.deleteMany = async (query) => {
    deletedBatchQuery = query;
    return { deletedCount: 2 };
  };
  mediaQueue.removeQueuedMediaJobsBulk = async (ids) => {
    removedQueueIds = ids;
  };
  mediaQueue.publishJobControl = async (payload) => {
    publishedPayloads.push(payload);
  };
  mediaQueue.clearJobProgressCachesBulk = async (ids) => {
    clearedCacheIds = ids;
  };

  try {
    const clearHandler = findJobRouteHandler('delete', '/');
    const { res, result } = createMockResponse();
    let capturedErr = null;
    await clearHandler({ user: { id: userId }, query: {} }, res, (err) => {
      capturedErr = err;
    });

    assert.equal(capturedErr, null);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, {
      success: true,
      deletedCount: 7,
      cancelledActiveCount: 3,
      deletedFilesCount: 0,
    });
    assert.equal(removedQueueIds.length, 7);
    assert.equal(clearedCacheIds.length, 7);
    assert.equal(deletedJobQuery.userId, userId);
    assert.deepEqual(deletedBatchQuery, {
      userId,
      batchId: { $in: ['batch-1', 'batch-2'] },
    });
    assert.deepEqual(publishedPayloads, [
      {
        action: 'cancel-many',
        jobIds: [downloadingId, muxingId, queuedId],
      },
    ]);

    assert.equal(fs.existsSync(matchingTmp), false);
    assert.equal(fs.existsSync(matchingPausedTmp), false);
    assert.equal(fs.existsSync(unrelatedTmp), true);
    assert.equal(fs.existsSync(readyFile), true);
  } finally {
    if (prevDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = prevDownloadsDir;
    Job.find = origFind;
    Job.deleteMany = origDeleteMany;
    Batch.deleteMany = origBatchDeleteMany;
    mediaQueue.removeQueuedMediaJobsBulk = origRemoveBulk;
    mediaQueue.publishJobControl = origPublish;
    mediaQueue.clearJobProgressCachesBulk = origClearBulk;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('DELETE /api/jobs?deleteFiles=true deletes safe files, removes empty playlist folders, and skips paths outside DOWNLOADS_DIR', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const prevDownloadsDir = process.env.DOWNLOADS_DIR;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-clear-files-'));
  const downloadsDir = path.join(tempRoot, 'downloads');
  const tmpDir = path.join(downloadsDir, '.mediavault-tmp');
  const playlistDir = path.join(downloadsDir, 'My_Playlist');
  const outsideFile = path.join(tempRoot, 'outside-secret.mp4');

  await fs.promises.mkdir(tmpDir, { recursive: true });
  await fs.promises.mkdir(playlistDir, { recursive: true });
  const rootReadyFile = path.join(downloadsDir, 'Single.mp4');
  const playlistReadyFile = path.join(playlistDir, 'Track_1.mp3');
  await fs.promises.writeFile(rootReadyFile, 'root-video');
  await fs.promises.writeFile(playlistReadyFile, 'track-audio');
  await fs.promises.writeFile(outsideFile, 'do-not-delete');

  process.env.DOWNLOADS_DIR = downloadsDir;

  const origFind = Job.find;
  const origDeleteMany = Job.deleteMany;
  const origBatchDeleteMany = Batch.deleteMany;
  const origRemoveBulk = mediaQueue.removeQueuedMediaJobsBulk;
  const origPublish = mediaQueue.publishJobControl;
  const origClearBulk = mediaQueue.clearJobProgressCachesBulk;

  const mockJobs = [
    {
      _id: { toString: () => '65b2d8e9f1a23c0012a42001' },
      status: 'ready',
      filePath: rootReadyFile,
      batchId: null,
    },
    {
      _id: { toString: () => '65b2d8e9f1a23c0012a42002' },
      status: 'ready',
      filePath: playlistReadyFile,
      batchId: 'pl-1',
    },
    {
      _id: { toString: () => '65b2d8e9f1a23c0012a42003' },
      status: 'ready',
      filePath: outsideFile,
      batchId: null,
    },
  ];

  Job.find = () => ({
    select: () => ({
      lean: async () => mockJobs,
    }),
  });
  Job.deleteMany = async () => ({ deletedCount: 3 });
  Batch.deleteMany = async () => ({ deletedCount: 1 });
  mediaQueue.removeQueuedMediaJobsBulk = async () => {};
  mediaQueue.publishJobControl = async () => {};
  mediaQueue.clearJobProgressCachesBulk = async () => {};

  try {
    const clearHandler = findJobRouteHandler('delete', '/');
    const { res, result } = createMockResponse();
    let capturedErr = null;
    await clearHandler(
      { user: { id: userId }, query: { deleteFiles: 'true' } },
      res,
      (err) => {
        capturedErr = err;
      }
    );

    assert.equal(capturedErr, null);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, {
      success: true,
      deletedCount: 3,
      cancelledActiveCount: 0,
      deletedFilesCount: 2,
    });
    assert.equal(fs.existsSync(rootReadyFile), false);
    assert.equal(fs.existsSync(playlistReadyFile), false);
    assert.equal(fs.existsSync(playlistDir), false);
    assert.equal(fs.existsSync(tmpDir), true);
    assert.equal(fs.existsSync(downloadsDir), true);
    assert.equal(fs.existsSync(outsideFile), true);
  } finally {
    if (prevDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = prevDownloadsDir;
    Job.find = origFind;
    Job.deleteMany = origDeleteMany;
    Batch.deleteMany = origBatchDeleteMany;
    mediaQueue.removeQueuedMediaJobsBulk = origRemoveBulk;
    mediaQueue.publishJobControl = origPublish;
    mediaQueue.clearJobProgressCachesBulk = origClearBulk;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

function toComparableValue(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matchesStoreQuery(doc, query = {}) {
  for (const [key, expected] of Object.entries(query)) {
    const raw = doc[key];
    const actual = raw && typeof raw.toString === 'function' && key === '_id' ? raw.toString() : raw;
    const isOperatorObj =
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Date) &&
      Object.keys(expected).some((k) => k.startsWith('$'));

    if (isOperatorObj) {
      if (Array.isArray(expected.$in)) {
        const normalized = expected.$in.map((v) =>
          v && typeof v.toString === 'function' ? v.toString() : v
        );
        if (!normalized.includes(actual)) return false;
      }
      if (Object.hasOwn(expected, '$ne')) {
        const actualNorm = actual === undefined ? null : toComparableValue(actual);
        const neNorm = expected.$ne === undefined ? null : toComparableValue(expected.$ne);
        if (actualNorm === neNorm) return false;
      }
      if (Object.hasOwn(expected, '$lte')) {
        if (actual === null || actual === undefined) return false;
        if (toComparableValue(actual) > toComparableValue(expected.$lte)) return false;
      }
    } else {
      const expectedVal =
        expected && typeof expected.toString === 'function' && key === '_id'
          ? expected.toString()
          : expected;
      if (actual !== expectedVal) return false;
    }
  }
  return true;
}

function installMockBatchAndJobStores({ jobs = [], batches = [], onAfterAggregate = null } = {}) {
  const origJobFindOne = Job.findOne;
  const origJobFind = Job.find;
  const origJobCountDocuments = Job.countDocuments;
  const origJobAggregate = Job.aggregate;
  const origJobFindByIdAndUpdate = Job.findByIdAndUpdate;
  const origJobDeleteOne = Job.deleteOne;
  const origJobDeleteMany = Job.deleteMany;
  const origJobUpdateOne = Job.updateOne;
  const origJobUpdateMany = Job.updateMany;
  const origBatchFindOne = Batch.findOne;
  const origBatchFindOneAndUpdate = Batch.findOneAndUpdate;
  const origBatchUpdateOne = Batch.updateOne;
  const origBatchDeleteOne = Batch.deleteOne;
  const origRemoveQueued = mediaQueue.removeQueuedMediaJob;
  const origClearCache = mediaQueue.clearJobProgressCache;
  const origRequeue = mediaQueue.requeueMediaJob;
  const origStatfs = fs.promises.statfs;

  const jobDocs = jobs.map((j) => ({
    ...j,
    _id: { toString: () => j.id },
  }));
  const batchDocs = batches.map((b) => ({
    rollupVersion: 0,
    ...b,
    _id: { toString: () => b._id || b.batchId },
  }));

  Job.findOne = async (query) => jobDocs.find((d) => matchesStoreQuery(d, query)) || null;
  Job.find = (query) => ({
    select: () => ({
      lean: async () => jobDocs.filter((d) => matchesStoreQuery(d, query)),
    }),
  });
  Job.countDocuments = async (query) =>
    jobDocs.filter((d) => matchesStoreQuery(d, query)).length;
  Job.aggregate = async (pipeline = []) => {
    const matchStage = pipeline.find((stage) => stage && stage.$match);
    const matching = matchStage
      ? jobDocs.filter((d) => matchesStoreQuery(d, matchStage.$match))
      : jobDocs;

    const result = matching.length
      ? [
          {
            _id: null,
            totalItems: matching.length,
            completedItems: matching.filter(
              (d) => d.status === 'ready' || d.status === 'expired'
            ).length,
            failedItems: matching.filter(
              (d) => d.status === 'failed' || d.status === 'cancelled'
            ).length,
          },
        ]
      : [];

    if (typeof onAfterAggregate === 'function') {
      await onAfterAggregate({
        batchId: matchStage?.$match?.batchId,
        result,
      });
    }

    return result;
  };
  Job.findByIdAndUpdate = async (id, update) => {
    const target = jobDocs.find((d) => matchesStoreQuery(d, { _id: id }));
    if (!target) return null;
    Object.assign(target, update && update.$set ? update.$set : update);
    return target;
  };
  Job.deleteOne = async (query) => {
    const idx = jobDocs.findIndex((d) => matchesStoreQuery(d, query));
    if (idx === -1) return { deletedCount: 0 };
    jobDocs.splice(idx, 1);
    return { deletedCount: 1 };
  };
  Job.deleteMany = async (query) => {
    let deletedCount = 0;
    for (let i = jobDocs.length - 1; i >= 0; i -= 1) {
      if (matchesStoreQuery(jobDocs[i], query)) {
        jobDocs.splice(i, 1);
        deletedCount += 1;
      }
    }
    return { deletedCount };
  };
  Job.updateOne = async (query, update) => {
    const target = jobDocs.find((d) => matchesStoreQuery(d, query));
    if (!target) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(target, update && update.$set ? update.$set : update);
    return { matchedCount: 1, modifiedCount: 1 };
  };
  Job.updateMany = async (query, update) => {
    const payload = update && update.$set ? update.$set : update;
    let modifiedCount = 0;
    for (const target of jobDocs) {
      if (matchesStoreQuery(target, query)) {
        Object.assign(target, payload);
        modifiedCount += 1;
      }
    }
    return { matchedCount: modifiedCount, modifiedCount };
  };

  Batch.findOne = async (query) => batchDocs.find((b) => matchesStoreQuery(b, query)) || null;
  Batch.findOneAndUpdate = async (query, update) => {
    const target = batchDocs.find((b) => matchesStoreQuery(b, query));
    if (!target) return null;
    if (update && update.$inc) {
      for (const [k, delta] of Object.entries(update.$inc)) {
        target[k] = Number(target[k] || 0) + Number(delta);
      }
    }
    if (update && update.$set) {
      Object.assign(target, update.$set);
    }
    return { ...target };
  };
  Batch.updateOne = async (query, update) => {
    const target = batchDocs.find((b) => matchesStoreQuery(b, query));
    if (!target) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(target, update && update.$set ? update.$set : update);
    return { matchedCount: 1, modifiedCount: 1 };
  };
  Batch.deleteOne = async (query) => {
    const idx = batchDocs.findIndex((b) => matchesStoreQuery(b, query));
    if (idx === -1) return { deletedCount: 0 };
    batchDocs.splice(idx, 1);
    return { deletedCount: 1 };
  };

  mediaQueue.removeQueuedMediaJob = async () => {};
  mediaQueue.clearJobProgressCache = async () => {};
  mediaQueue.requeueMediaJob = async () => {};
  fs.promises.statfs = async () => ({ bavail: 1000000, bsize: 4096 * 1024 });

  return {
    jobDocs,
    batchDocs,
    restore() {
      Job.findOne = origJobFindOne;
      Job.find = origJobFind;
      Job.countDocuments = origJobCountDocuments;
      Job.aggregate = origJobAggregate;
      Job.findByIdAndUpdate = origJobFindByIdAndUpdate;
      Job.deleteOne = origJobDeleteOne;
      Job.deleteMany = origJobDeleteMany;
      Job.updateOne = origJobUpdateOne;
      Job.updateMany = origJobUpdateMany;
      Batch.findOne = origBatchFindOne;
      Batch.findOneAndUpdate = origBatchFindOneAndUpdate;
      Batch.updateOne = origBatchUpdateOne;
      Batch.deleteOne = origBatchDeleteOne;
      mediaQueue.removeQueuedMediaJob = origRemoveQueued;
      mediaQueue.clearJobProgressCache = origClearCache;
      mediaQueue.requeueMediaJob = origRequeue;
      fs.promises.statfs = origStatfs;
    },
  };
}

test('DELETE /api/jobs/:id reconciles batch rollup on queued/failed/ready deletions and deletes empty batch', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const deleteHandler = findJobRouteHandler('delete', '/:id');

  // Case 1: deleting queued child from [ready, queued] completes the batch
  const store1 = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-queued',
        userId,
        totalItems: 2,
        completedItems: 1,
        failedItems: 0,
        status: 'processing',
      },
    ],
    jobs: [
      { id: '65b2d8e9f1a23c0012a43001', userId, batchId: 'b-queued', status: 'ready' },
      { id: '65b2d8e9f1a23c0012a43002', userId, batchId: 'b-queued', status: 'queued' },
    ],
  });

  try {
    const { res, result } = createMockResponse();
    let err = null;
    await deleteHandler(
      { params: { id: '65b2d8e9f1a23c0012a43002' }, user: { id: userId } },
      res,
      (e) => { err = e; }
    );
    assert.equal(err, null);
    assert.equal(result.statusCode, 200);
    assert.equal(store1.batchDocs.length, 1);
    assert.equal(store1.batchDocs[0].totalItems, 1);
    assert.equal(store1.batchDocs[0].completedItems, 1);
    assert.equal(store1.batchDocs[0].failedItems, 0);
    assert.equal(store1.batchDocs[0].status, 'completed');

    // Case 2: deleting final remaining child removes orphan batch
    const { res: resLast, result: outLast } = createMockResponse();
    let errLast = null;
    await deleteHandler(
      { params: { id: '65b2d8e9f1a23c0012a43001' }, user: { id: userId } },
      resLast,
      (e) => { errLast = e; }
    );
    assert.equal(errLast, null);
    assert.equal(outLast.statusCode, 200);
    assert.equal(store1.batchDocs.length, 0);
  } finally {
    store1.restore();
  }

  // Case 3: deleting ready child from [ready, failed] transitions partial_failure -> failed
  const store2 = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-partial',
        userId,
        totalItems: 2,
        completedItems: 1,
        failedItems: 1,
        status: 'partial_failure',
      },
    ],
    jobs: [
      { id: '65b2d8e9f1a23c0012a43011', userId, batchId: 'b-partial', status: 'ready' },
      { id: '65b2d8e9f1a23c0012a43012', userId, batchId: 'b-partial', status: 'failed' },
    ],
  });

  try {
    const { res, result } = createMockResponse();
    let err = null;
    await deleteHandler(
      { params: { id: '65b2d8e9f1a23c0012a43011' }, user: { id: userId } },
      res,
      (e) => { err = e; }
    );
    assert.equal(err, null);
    assert.equal(result.statusCode, 200);
    assert.equal(store2.batchDocs[0].totalItems, 1);
    assert.equal(store2.batchDocs[0].completedItems, 0);
    assert.equal(store2.batchDocs[0].failedItems, 1);
    assert.equal(store2.batchDocs[0].status, 'failed');
  } finally {
    store2.restore();
  }

  // Case 4: deleting queued sibling while downloading keeps processing with decremented totalItems until worker completes
  const store3 = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-active',
        userId,
        totalItems: 2,
        completedItems: 0,
        failedItems: 0,
        status: 'processing',
      },
    ],
    jobs: [
      { id: '65b2d8e9f1a23c0012a43021', userId, batchId: 'b-active', status: 'downloading' },
      { id: '65b2d8e9f1a23c0012a43022', userId, batchId: 'b-active', status: 'queued' },
    ],
  });

  try {
    const { res } = createMockResponse();
    await deleteHandler(
      { params: { id: '65b2d8e9f1a23c0012a43022' }, user: { id: userId } },
      res,
      (e) => { throw e; }
    );
    assert.equal(store3.batchDocs[0].totalItems, 1);
    assert.equal(store3.batchDocs[0].status, 'processing');

    store3.jobDocs[0].status = 'ready';
    await updateBatchRollup('b-active');
    assert.equal(store3.batchDocs[0].totalItems, 1);
    assert.equal(store3.batchDocs[0].completedItems, 1);
    assert.equal(store3.batchDocs[0].status, 'completed');
  } finally {
    store3.restore();
  }
});

test('DELETE /api/jobs/expired and POST /api/jobs/:id/retry reconcile affected batch rollups', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const deleteExpiredHandler = findJobRouteHandler('delete', '/expired');
  const retryHandler = findJobRouteHandler('post', '/:id/retry');

  const store = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-exp-mixed',
        userId,
        totalItems: 2,
        completedItems: 1,
        failedItems: 1,
        status: 'partial_failure',
      },
      {
        batchId: 'b-exp-only',
        userId,
        totalItems: 1,
        completedItems: 1,
        failedItems: 0,
        status: 'completed',
      },
      {
        batchId: 'b-retry',
        userId,
        totalItems: 2,
        completedItems: 1,
        failedItems: 1,
        status: 'partial_failure',
      },
    ],
    jobs: [
      { id: '65b2d8e9f1a23c0012a44001', userId, batchId: 'b-exp-mixed', status: 'expired' },
      { id: '65b2d8e9f1a23c0012a44002', userId, batchId: 'b-exp-mixed', status: 'failed' },
      { id: '65b2d8e9f1a23c0012a44003', userId, batchId: 'b-exp-only', status: 'expired' },
      { id: '65b2d8e9f1a23c0012a44004', userId, batchId: 'b-retry', status: 'ready' },
      {
        id: '65b2d8e9f1a23c0012a44005',
        userId,
        batchId: 'b-retry',
        platform: 'youtube',
        useCookies: false,
        status: 'failed',
      },
    ],
  });

  try {
    const { res: resExp, result: outExp } = createMockResponse();
    let errExp = null;
    await deleteExpiredHandler({ user: { id: userId } }, resExp, (e) => { errExp = e; });
    assert.equal(errExp, null);
    assert.equal(outExp.statusCode, 200);
    assert.equal(outExp.payload.deletedCount, 2);

    const mixedBatch = store.batchDocs.find((b) => b.batchId === 'b-exp-mixed');
    assert.equal(mixedBatch.totalItems, 1);
    assert.equal(mixedBatch.completedItems, 0);
    assert.equal(mixedBatch.failedItems, 1);
    assert.equal(mixedBatch.status, 'failed');

    const onlyBatch = store.batchDocs.find((b) => b.batchId === 'b-exp-only');
    assert.equal(onlyBatch, undefined);

    const { res: resRetry, result: outRetry } = createMockResponse();
    let errRetry = null;
    await retryHandler(
      { params: { id: '65b2d8e9f1a23c0012a44005' }, body: {}, user: { id: userId } },
      resRetry,
      (e) => { errRetry = e; }
    );
    assert.equal(errRetry, null);
    assert.equal(outRetry.statusCode, 202);

    const retryBatch = store.batchDocs.find((b) => b.batchId === 'b-retry');
    assert.equal(retryBatch.totalItems, 2);
    assert.equal(retryBatch.completedItems, 1);
    assert.equal(retryBatch.failedItems, 0);
    assert.equal(retryBatch.status, 'processing');
  } finally {
    store.restore();
  }
});

test('updateBatchRollup prevents stale concurrent snapshots from overwriting newer batch completion or deletion', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';

  // Case 1: stale delete rollup snapshot cannot overwrite concurrent worker completion
  let race1Calls = 0;
  let store1;
  store1 = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-race-complete',
        userId,
        totalItems: 2,
        completedItems: 0,
        failedItems: 0,
        status: 'processing',
        rollupVersion: 0,
      },
    ],
    jobs: [
      { id: '65b2d8e9f1a23c0012a45001', userId, batchId: 'b-race-complete', status: 'downloading' },
    ],
    onAfterAggregate: async () => {
      race1Calls += 1;
      if (race1Calls === 1) {
        // Worker marks remaining sibling ready and finishes newer rollup before first rollup writes
        store1.jobDocs[0].status = 'ready';
        const newerResult = await updateBatchRollup('b-race-complete');
        assert.deepEqual(newerResult, {
          deleted: false,
          batch: {
            batchId: 'b-race-complete',
            totalItems: 1,
            completedItems: 1,
            failedItems: 0,
            status: 'completed',
          },
        });
      }
    },
  });

  try {
    const staleResult = await updateBatchRollup('b-race-complete');
    assert.deepEqual(staleResult, { deleted: false, superseded: true });
    assert.equal(store1.batchDocs.length, 1);
    assert.equal(store1.batchDocs[0].totalItems, 1);
    assert.equal(store1.batchDocs[0].completedItems, 1);
    assert.equal(store1.batchDocs[0].failedItems, 0);
    assert.equal(store1.batchDocs[0].status, 'completed');
    assert.equal(store1.batchDocs[0].rollupVersion, 2);
  } finally {
    store1.restore();
  }

  // Case 2: stale non-empty delete rollup cannot resurrect or interfere with concurrent final-delete removal
  let race2Calls = 0;
  let store2;
  store2 = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-race-delete',
        userId,
        totalItems: 2,
        completedItems: 1,
        failedItems: 0,
        status: 'processing',
        rollupVersion: 0,
      },
    ],
    jobs: [
      { id: '65b2d8e9f1a23c0012a45012', userId, batchId: 'b-race-delete', status: 'queued' },
    ],
    onAfterAggregate: async () => {
      race2Calls += 1;
      if (race2Calls === 1) {
        // Concurrent request deletes the final remaining job and runs rollup -> removes Batch
        store2.jobDocs.length = 0;
        const finalDeleteRes = await updateBatchRollup('b-race-delete');
        assert.deepEqual(finalDeleteRes, { deleted: true });
      }
    },
  });

  try {
    const staleDeleteRes = await updateBatchRollup('b-race-delete');
    assert.deepEqual(staleDeleteRes, { deleted: false, superseded: true });
    assert.equal(store2.batchDocs.length, 0);
  } finally {
    store2.restore();
  }
});

test('Job schema uses non-TTL expiresAt index and ensureNonTtlExpiresIndex drops legacy TTL index', async () => {
  const expiresIdx = Job.schema.indexes().find(([fields]) => fields && fields.expiresAt === 1);
  assert.ok(expiresIdx, 'Expected index on expiresAt');
  assert.equal(expiresIdx[1].expireAfterSeconds, undefined);

  const origIndexes = Job.collection.indexes;
  const origDropIndex = Job.collection.dropIndex;
  const origCreateIndexes = Job.createIndexes;

  const dropped = [];
  let createCalls = 0;

  Job.collection.indexes = async () => [
    { name: '_id_', key: { _id: 1 } },
    { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ];
  Job.collection.dropIndex = async (name) => {
    dropped.push(name);
  };
  Job.createIndexes = async () => {
    createCalls += 1;
  };

  try {
    await Job.ensureNonTtlExpiresIndex();
    assert.deepEqual(dropped, ['expiresAt_1']);
    assert.equal(createCalls, 1);

    Job.collection.dropIndex = async () => {
      throw Object.assign(new Error('already dropped'), { code: 27 });
    };
    await Job.ensureNonTtlExpiresIndex();
    assert.equal(createCalls, 2);

    // Gracefully handles collections that do not exist yet
    Job.collection.indexes = async () => {
      const err = new Error('ns does not exist');
      err.code = 26;
      err.codeName = 'NamespaceNotFound';
      throw err;
    };
    await Job.ensureNonTtlExpiresIndex();
    assert.equal(createCalls, 3);
  } finally {
    Job.collection.indexes = origIndexes;
    Job.collection.dropIndex = origDropIndex;
    Job.createIndexes = origCreateIndexes;
  }
});

test('runStorageCleanup retries failed unlinks before reconciling expired jobs and aged files', async (t) => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-cleanup-batch-'));
  const playlistDir = path.join(tempRoot, 'Sample_Playlist');
  await fs.promises.mkdir(playlistDir, { recursive: true });

  const ttlFile = path.join(tempRoot, 'expired-ttl.mp4');
  const orphanFile = path.join(playlistDir, 'aged-orphan.mp4');
  await fs.promises.writeFile(ttlFile, 'ttl-data');
  await fs.promises.writeFile(orphanFile, 'orphan-data');
  const pastTime = new Date(Date.now() - 120_000);
  await fs.promises.utimes(orphanFile, pastTime, pastTime);

  const store = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-cleanup-ttl',
        userId,
        totalItems: 1,
        completedItems: 0,
        failedItems: 0,
        status: 'processing',
      },
      {
        batchId: 'b-cleanup-orphan',
        userId,
        totalItems: 1,
        completedItems: 0,
        failedItems: 0,
        status: 'processing',
      },
    ],
    jobs: [
      {
        id: '65b2d8e9f1a23c0012a46001',
        userId,
        batchId: 'b-cleanup-ttl',
        status: 'ready',
        filePath: ttlFile,
        expiresAt: new Date(Date.now() - 5_000),
      },
      {
        id: '65b2d8e9f1a23c0012a46002',
        userId,
        batchId: 'b-cleanup-orphan',
        status: 'ready',
        filePath: orphanFile,
        expiresAt: null,
      },
    ],
  });

  try {
    const unlink = t.mock.method(fs.promises, 'unlink', async () => {
      throw Object.assign(new Error('file busy'), { code: 'EBUSY' });
    });
    await runStorageCleanup({ downloadsDir: tempRoot, downloadTtlMs: 60_000 });
    assert.deepEqual(store.jobDocs.map(job => job.filePath), [ttlFile, orphanFile]);
    assert.ok(store.jobDocs.every(job => job.status === 'ready'));
    assert.ok(store.batchDocs.every(batch => batch.status === 'processing'));
    unlink.mock.restore();

    // Another process removes the TTL file before the retry; ENOENT is success.
    await fs.promises.unlink(ttlFile);
    await runStorageCleanup({ downloadsDir: tempRoot, downloadTtlMs: 60_000 });

    assert.equal(fs.existsSync(ttlFile), false);
    assert.equal(fs.existsSync(orphanFile), false);
    assert.equal(fs.existsSync(playlistDir), false);

    assert.equal(store.jobDocs[0].status, 'expired');
    assert.equal(store.jobDocs[0].filePath, null);
    assert.equal(store.jobDocs[1].status, 'expired');
    assert.equal(store.jobDocs[1].filePath, null);

    const ttlBatch = store.batchDocs.find((b) => b.batchId === 'b-cleanup-ttl');
    assert.equal(ttlBatch.totalItems, 1);
    assert.equal(ttlBatch.completedItems, 1);
    assert.equal(ttlBatch.failedItems, 0);
    assert.equal(ttlBatch.status, 'completed');
    assert.equal(ttlBatch.rollupVersion, 1);

    const orphanBatch = store.batchDocs.find((b) => b.batchId === 'b-cleanup-orphan');
    assert.equal(orphanBatch.totalItems, 1);
    assert.equal(orphanBatch.completedItems, 1);
    assert.equal(orphanBatch.failedItems, 0);
    assert.equal(orphanBatch.status, 'completed');
    assert.equal(orphanBatch.rollupVersion, 1);
  } finally {
    store.restore();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('GET /api/jobs/:id/file reconciles parent batch rollup when ready file is missing from disk', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const prevDownloadsDir = process.env.DOWNLOADS_DIR;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-missing-file-'));
  process.env.DOWNLOADS_DIR = tempRoot;

  const missingPath = path.join(tempRoot, 'missing-track.mp4');
  const fileHandler = findJobRouteHandler('get', '/:id/file');

  const store = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-missing-file',
        userId,
        totalItems: 1,
        completedItems: 0,
        failedItems: 0,
        status: 'processing',
      },
    ],
    jobs: [
      {
        id: '65b2d8e9f1a23c0012a46011',
        userId,
        batchId: 'b-missing-file',
        status: 'ready',
        filePath: missingPath,
        expiresAt: null,
      },
    ],
  });

  try {
    let capturedErr = null;
    await fileHandler(
      { params: { id: '65b2d8e9f1a23c0012a46011' }, user: { id: userId } },
      { download() {} },
      (err) => {
        capturedErr = err;
      }
    );

    assert.equal(capturedErr.statusCode, 404);
    assert.equal(capturedErr.code, 'JOB_NOT_FOUND');
    assert.equal(store.jobDocs[0].status, 'expired');
    assert.equal(store.jobDocs[0].filePath, null);

    assert.equal(store.batchDocs[0].totalItems, 1);
    assert.equal(store.batchDocs[0].completedItems, 1);
    assert.equal(store.batchDocs[0].failedItems, 0);
    assert.equal(store.batchDocs[0].status, 'completed');
    assert.equal(store.batchDocs[0].rollupVersion, 1);
  } finally {
    if (prevDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = prevDownloadsDir;
    store.restore();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

function installProcessJobHarness({ initialJob, batchDoc = null } = {}) {
  const origJobFindById = Job.findById;
  const origJobFindOneAndUpdate = Job.findOneAndUpdate;
  const origJobFindByIdAndUpdate = Job.findByIdAndUpdate;
  const origBatchFindOne = Batch.findOne;
  const origStatfs = fs.promises.statfs;
  const origSetCache = mediaQueue.setJobProgressCache;
  const origClearCache = mediaQueue.clearJobProgressCache;

  const jobState = {
    progress: 0,
    errorMessage: null,
    ...initialJob,
    _id: { toString: () => initialJob.id },
  };
  const cacheWrites = [];
  const dbUpdates = [];

  Job.findById = (id) => {
    const matches = String(id) === jobState.id;
    return Object.assign(Promise.resolve(matches ? { ...jobState } : null), {
      select: () => ({
        lean: async () => (matches ? { status: jobState.status } : null),
      }),
    });
  };

  Job.findOneAndUpdate = async (filter, update) => {
    if (filter && filter._id && String(filter._id) !== jobState.id) {
      return null;
    }
    const allowed = filter?.status?.$in;
    if (Array.isArray(allowed) && !allowed.includes(jobState.status)) {
      return null;
    }
    const payload = update && update.$set ? update.$set : update;
    dbUpdates.push({ filter, payload: { ...payload } });
    Object.assign(jobState, payload);
    return { ...jobState };
  };

  Job.findByIdAndUpdate = async (id, update) => {
    if (String(id) !== jobState.id) return null;
    const payload = update && update.$set ? update.$set : update;
    dbUpdates.push({ filter: { _id: id }, payload: { ...payload } });
    Object.assign(jobState, payload);
    return { ...jobState };
  };

  Batch.findOne = (query) => {
    const matched = batchDoc && batchDoc.batchId === query?.batchId ? { ...batchDoc } : null;
    return Object.assign(Promise.resolve(matched), {
      select: () => ({
        lean: async () => matched,
      }),
    });
  };

  fs.promises.statfs = async () => ({ bavail: 1000000, bsize: 4096 * 1024 });
  mediaQueue.setJobProgressCache = async (id, payload) => {
    cacheWrites.push({ id, ...payload });
  };
  mediaQueue.clearJobProgressCache = async () => {};

  const runtimeDeps = {
    resolvePublicUrl: async (rawUrl) => ({
      hostname: new URL(rawUrl).hostname,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    }),
    createPinnedSsrfProxy: async () => ({
      proxyUrl: 'http://mv:tok@127.0.0.1:49999',
      getLastBlockedError: () => null,
      close: async () => {},
    }),
  };

  return {
    jobState,
    cacheWrites,
    dbUpdates,
    runtimeDeps,
    restore() {
      Job.findById = origJobFindById;
      Job.findOneAndUpdate = origJobFindOneAndUpdate;
      Job.findByIdAndUpdate = origJobFindByIdAndUpdate;
      Batch.findOne = origBatchFindOne;
      fs.promises.statfs = origStatfs;
      mediaQueue.setJobProgressCache = origSetCache;
      mediaQueue.clearJobProgressCache = origClearCache;
    },
  };
}

test('processJob guards progress and failure updates against external pause and retry transitions', async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-worker-race-'));

  try {
    // 1. Progress callbacks & failure cannot overwrite external pause
    const hPause = installProcessJobHarness({
      initialJob: {
        id: '65b2d8e9f1a23c0012a47001',
        sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        mode: 'video',
        container: 'mp4',
        formatSelector: '137+140',
        useCookies: false,
        status: 'queued',
        title: 'Pause Race Video',
        batchId: null,
      },
    });

    try {
      const stoppedReasons = [];
      await processJob(
        { data: { jobId: hPause.jobState.id } },
        {
          ...hPause.runtimeDeps,
          downloadsDir: tempRoot,
          runYtDlpDownload: async ({ onController, onProgress, onMuxing }) => {
            onController({
              stop(reason) {
                stoppedReasons.push(reason);
              },
            });
            // External pause lands in DB before Redis control signal reaches worker
            hPause.jobState.status = 'paused';
            onProgress({ percentage: 45, totalSize: '10MiB', downloadSpeed: '1MiB/s', eta: '00:05' });
            onMuxing();
            await new Promise((resolve) => setTimeout(resolve, 25));
            throw new Error('Download interrupted after external pause');
          },
        }
      );

      assert.equal(hPause.jobState.status, 'paused');
      assert.equal(hPause.jobState.errorMessage, null);
      assert.equal(hPause.cacheWrites.length, 1); // Initial claim only; progress/muxing blocked
      assert.ok(stoppedReasons.includes('external'));
    } finally {
      hPause.restore();
    }

    // 2. Progress callbacks & failure cannot overwrite external retry (status reset to 'queued')
    const hRetry = installProcessJobHarness({
      initialJob: {
        id: '65b2d8e9f1a23c0012a47002',
        sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        mode: 'video',
        container: 'mp4',
        formatSelector: '137+140',
        useCookies: false,
        status: 'queued',
        title: 'Retry Race Video',
        batchId: null,
      },
    });

    try {
      await processJob(
        { data: { jobId: hRetry.jobState.id } },
        {
          ...hRetry.runtimeDeps,
          downloadsDir: tempRoot,
          runYtDlpDownload: async ({ onProgress }) => {
            // External retry resets job back to queued while prior run winds down
            hRetry.jobState.status = 'queued';
            onProgress({ percentage: 60, totalSize: '20MiB', downloadSpeed: '2MiB/s', eta: '00:03' });
            await new Promise((resolve) => setTimeout(resolve, 25));
            throw new Error('Prior run killed during retry');
          },
        }
      );

      assert.equal(hRetry.jobState.status, 'queued');
      assert.equal(hRetry.jobState.errorMessage, null);
      assert.equal(hRetry.cacheWrites.length, 1);
    } finally {
      hRetry.restore();
    }
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('processJob isolates batch rollup failures after ready commit without downgrading job to failed', async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-worker-rollup-err-'));
  const origBatchFindOneAndUpdate = Batch.findOneAndUpdate;
  const h = installProcessJobHarness({
    initialJob: {
      id: '65b2d8e9f1a23c0012a47003',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      mode: 'video',
      container: 'mp4',
      formatSelector: '137+140',
      useCookies: false,
      status: 'queued',
      title: 'Rollup Error Video',
      batchId: 'b-rollup-err',
    },
    batchDoc: {
      batchId: 'b-rollup-err',
      playlistTitle: 'Rollup Error Batch',
    },
  });

  Batch.findOneAndUpdate = async () => {
    throw new Error('Transient Mongo rollup failure');
  };

  try {
    await processJob(
      { data: { jobId: h.jobState.id } },
      {
        ...h.runtimeDeps,
        downloadsDir: tempRoot,
        runYtDlpDownload: async () => {
          const outFile = path.join(tempRoot, '.mediavault-tmp', `${h.jobState.id}.mp4`);
          await fs.promises.writeFile(outFile, 'completed-video-bytes');
          return { code: 0, stoppedReason: null };
        },
      }
    );

    assert.equal(h.jobState.status, 'ready');
    assert.equal(h.jobState.progress, 100);
    assert.equal(h.jobState.errorMessage, null);
    assert.ok(h.jobState.filePath && fs.existsSync(h.jobState.filePath));
  } finally {
    Batch.findOneAndUpdate = origBatchFindOneAndUpdate;
    h.restore();
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('pause, pause-all, resume, and retry reject or exclude jobs that completed concurrently', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const downloadingId = '65b2d8e9f1a23c0012a48001';
  const queuedId = '65b2d8e9f1a23c0012a48002';
  const pausedId = '65b2d8e9f1a23c0012a48003';

  const origFindOne = Job.findOne;
  const origFind = Job.find;
  const origUpdateOne = Job.updateOne;
  const origUpdateMany = Job.updateMany;
  const origRemoveQueued = mediaQueue.removeQueuedMediaJob;
  const origPublish = mediaQueue.publishJobControl;
  const origClearCache = mediaQueue.clearJobProgressCache;
  const origRequeue = mediaQueue.requeueMediaJob;
  const origStatfs = fs.promises.statfs;

  const store = [];
  let onAfterRead = null;
  const removedIds = [];
  const clearedIds = [];
  const published = [];
  const requeuedIds = [];

  Job.findOne = async (query) => {
    const doc = store.find((d) => matchesStoreQuery(d, query));
    const snapshot = doc ? { ...doc } : null;
    if (onAfterRead) {
      const hook = onAfterRead;
      onAfterRead = null;
      hook();
    }
    return snapshot;
  };
  Job.find = (query) => ({
    select: () => ({
      lean: async () => {
        const docs = store.filter((d) => matchesStoreQuery(d, query)).map((d) => ({ ...d }));
        if (onAfterRead) {
          const hook = onAfterRead;
          onAfterRead = null;
          hook();
        }
        return docs;
      },
    }),
  });
  Job.updateOne = async (query, update) => {
    const target = store.find((d) => matchesStoreQuery(d, query));
    if (!target) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(target, update && update.$set ? update.$set : update);
    return { matchedCount: 1, modifiedCount: 1 };
  };
  Job.updateMany = async (query, update) => {
    const payload = update && update.$set ? update.$set : update;
    let matchedCount = 0;
    for (const doc of store) {
      if (matchesStoreQuery(doc, query)) {
        Object.assign(doc, payload);
        matchedCount += 1;
      }
    }
    return { matchedCount, modifiedCount: matchedCount };
  };
  mediaQueue.removeQueuedMediaJob = async (id) => {
    removedIds.push(id);
  };
  mediaQueue.publishJobControl = async (payload) => {
    published.push(payload);
  };
  mediaQueue.clearJobProgressCache = async (id) => {
    clearedIds.push(id);
  };
  mediaQueue.requeueMediaJob = async (doc) => {
    requeuedIds.push(doc._id.toString());
  };
  fs.promises.statfs = async () => ({ bavail: 1000000, bsize: 4096 * 1024 });

  try {
    const pauseHandler = findJobRouteHandler('post', '/:id/pause');
    const pauseAllHandler = findJobRouteHandler('post', '/pause-all');
    const resumeHandler = findJobRouteHandler('post', '/:id/resume');
    const retryHandler = findJobRouteHandler('post', '/:id/retry');

    // 1. Single pause conflicts (409) when worker commits ready between read and CAS
    store.splice(0, store.length, {
      id: downloadingId,
      _id: { toString: () => downloadingId },
      userId,
      status: 'downloading',
      filePath: '/data/downloads/done.mp4',
    });
    onAfterRead = () => {
      store[0].status = 'ready';
    };
    const { res: rPause, result: outPause } = createMockResponse();
    let errPause = null;
    await pauseHandler({ params: { id: downloadingId }, user: { id: userId } }, rPause, (e) => {
      errPause = e;
    });
    assert.equal(outPause.statusCode, null);
    assert.equal(errPause.statusCode, 409);
    assert.equal(errPause.code, 'INVALID_JOB_STATE');
    assert.equal(store[0].status, 'ready');
    assert.equal(store[0].filePath, '/data/downloads/done.mp4');
    assert.equal(published.length, 0);
    assert.equal(clearedIds.length, 0);

    // 2. Single retry conflicts (409) when worker commits ready between read and CAS
    store.splice(0, store.length, {
      id: downloadingId,
      _id: { toString: () => downloadingId },
      userId,
      platform: 'youtube',
      useCookies: false,
      status: 'downloading',
      batchId: 'b-concurrent',
      filePath: '/data/downloads/done.mp4',
    });
    onAfterRead = () => {
      store[0].status = 'ready';
    };
    const { res: rRetry, result: outRetry } = createMockResponse();
    let errRetry = null;
    await retryHandler(
      { params: { id: downloadingId }, body: {}, user: { id: userId } },
      rRetry,
      (e) => {
        errRetry = e;
      }
    );
    assert.equal(outRetry.statusCode, null);
    assert.equal(errRetry.statusCode, 409);
    assert.equal(errRetry.code, 'INVALID_JOB_STATE');
    assert.equal(store[0].status, 'ready');
    assert.equal(requeuedIds.length, 0);
    assert.equal(published.length, 0);

    // 3. Single resume conflicts (409) when job state changed concurrently
    store.splice(0, store.length, {
      id: pausedId,
      _id: { toString: () => pausedId },
      userId,
      platform: 'youtube',
      useCookies: false,
      status: 'paused',
    });
    onAfterRead = () => {
      store[0].status = 'queued';
    };
    const { res: rResume } = createMockResponse();
    let errResume = null;
    await resumeHandler({ params: { id: pausedId }, user: { id: userId } }, rResume, (e) => {
      errResume = e;
    });
    assert.equal(errResume.statusCode, 409);
    assert.equal(errResume.code, 'INVALID_JOB_STATE');
    assert.equal(requeuedIds.length, 0);

    // 4. pause-all excludes a downloading job that committed ready after the initial read
    store.splice(
      0,
      store.length,
      {
        id: downloadingId,
        _id: { toString: () => downloadingId },
        userId,
        status: 'downloading',
        filePath: '/data/downloads/done.mp4',
      },
      {
        id: queuedId,
        _id: { toString: () => queuedId },
        userId,
        status: 'queued',
      }
    );
    onAfterRead = () => {
      store[0].status = 'ready';
    };
    const { res: rPauseAll, result: outPauseAll } = createMockResponse();
    let errPauseAll = null;
    await pauseAllHandler({ user: { id: userId } }, rPauseAll, (e) => {
      errPauseAll = e;
    });
    assert.equal(errPauseAll, null);
    assert.equal(outPauseAll.statusCode, 200);
    assert.deepEqual(outPauseAll.payload, { success: true, pausedCount: 1 });
    assert.equal(store[0].status, 'ready');
    assert.equal(store[1].status, 'paused');
    assert.deepEqual(removedIds, [queuedId]);
    assert.deepEqual(clearedIds, [queuedId]);
    assert.equal(published.length, 0);

    // 5. pause-all returns pausedCount: 0 cleanly when all jobs finish before updateMany
    removedIds.length = 0;
    clearedIds.length = 0;
    store.splice(0, store.length, {
      id: downloadingId,
      _id: { toString: () => downloadingId },
      userId,
      status: 'downloading',
    });
    onAfterRead = () => {
      store[0].status = 'ready';
    };
    const { res: rPauseZero, result: outPauseZero } = createMockResponse();
    let errPauseZero = null;
    await pauseAllHandler({ user: { id: userId } }, rPauseZero, (e) => {
      errPauseZero = e;
    });
    assert.equal(errPauseZero, null);
    assert.equal(outPauseZero.statusCode, 200);
    assert.deepEqual(outPauseZero.payload, { success: true, pausedCount: 0 });
    assert.equal(store[0].status, 'ready');
    assert.equal(removedIds.length, 0);
    assert.equal(clearedIds.length, 0);
    assert.equal(published.length, 0);
  } finally {
    Job.findOne = origFindOne;
    Job.find = origFind;
    Job.updateOne = origUpdateOne;
    Job.updateMany = origUpdateMany;
    mediaQueue.removeQueuedMediaJob = origRemoveQueued;
    mediaQueue.publishJobControl = origPublish;
    mediaQueue.clearJobProgressCache = origClearCache;
    mediaQueue.requeueMediaJob = origRequeue;
    fs.promises.statfs = origStatfs;
  }
});

test('DELETE /api/jobs?deleteFiles=true fences open jobs and deletes files completed after initial snapshot', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const prevDownloadsDir = process.env.DOWNLOADS_DIR;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-clear-late-'));
  const playlistDir = path.join(tempRoot, 'Late_Playlist');
  await fs.promises.mkdir(playlistDir, { recursive: true });
  const lateFilePath = path.join(playlistDir, 'Late_Finish.mp4');
  await fs.promises.writeFile(lateFilePath, 'late-video-bytes');

  process.env.DOWNLOADS_DIR = tempRoot;

  const downloadingId = '65b2d8e9f1a23c0012a49001';
  const queuedId = '65b2d8e9f1a23c0012a49002';

  const origFind = Job.find;
  const origUpdateMany = Job.updateMany;
  const origDeleteMany = Job.deleteMany;
  const origBatchDeleteMany = Batch.deleteMany;
  const origRemoveBulk = mediaQueue.removeQueuedMediaJobsBulk;
  const origPublish = mediaQueue.publishJobControl;
  const origClearBulk = mediaQueue.clearJobProgressCachesBulk;

  const liveJobs = [
    {
      id: downloadingId,
      _id: { toString: () => downloadingId },
      userId,
      status: 'downloading',
      filePath: null,
      batchId: 'b-late',
    },
    {
      id: queuedId,
      _id: { toString: () => queuedId },
      userId,
      status: 'queued',
      filePath: null,
      batchId: 'b-late',
    },
  ];
  let fencedQueuedToCancelled = false;

  Job.find = (query) => ({
    select: () => ({
      lean: async () =>
        liveJobs
          .filter((d) => matchesStoreQuery(d, query))
          .map((d) => ({ ...d })),
    }),
  });
  mediaQueue.removeQueuedMediaJobsBulk = async () => {
    // Worker finishes downloadingId and persists filePath right before fence/deleteMany
    liveJobs[0].status = 'ready';
    liveJobs[0].filePath = lateFilePath;
  };
  Job.updateMany = async (query, update) => {
    const payload = update && update.$set ? update.$set : update;
    let modifiedCount = 0;
    for (const d of liveJobs) {
      if (matchesStoreQuery(d, query)) {
        Object.assign(d, payload);
        modifiedCount += 1;
      }
    }
    fencedQueuedToCancelled = liveJobs[1].status === 'cancelled';
    return { matchedCount: modifiedCount, modifiedCount };
  };
  Job.deleteMany = async (query) => {
    let deletedCount = 0;
    for (let i = liveJobs.length - 1; i >= 0; i -= 1) {
      if (matchesStoreQuery(liveJobs[i], query)) {
        liveJobs.splice(i, 1);
        deletedCount += 1;
      }
    }
    return { deletedCount };
  };
  Batch.deleteMany = async () => ({ deletedCount: 1 });
  mediaQueue.publishJobControl = async () => {};
  mediaQueue.clearJobProgressCachesBulk = async () => {};

  try {
    const clearHandler = findJobRouteHandler('delete', '/');
    const { res, result } = createMockResponse();
    let capturedErr = null;
    await clearHandler(
      { user: { id: userId }, query: { deleteFiles: 'true' } },
      res,
      (err) => {
        capturedErr = err;
      }
    );

    assert.equal(capturedErr, null);
    assert.equal(result.statusCode, 200);
    assert.equal(fencedQueuedToCancelled, true);
    assert.equal(liveJobs.length, 0);
    assert.deepEqual(result.payload, {
      success: true,
      deletedCount: 2,
      cancelledActiveCount: 2,
      deletedFilesCount: 1,
    });
    assert.equal(fs.existsSync(lateFilePath), false);
    assert.equal(fs.existsSync(playlistDir), false);
  } finally {
    if (prevDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = prevDownloadsDir;
    Job.find = origFind;
    Job.updateMany = origUpdateMany;
    Job.deleteMany = origDeleteMany;
    Batch.deleteMany = origBatchDeleteMany;
    mediaQueue.removeQueuedMediaJobsBulk = origRemoveBulk;
    mediaQueue.publishJobControl = origPublish;
    mediaQueue.clearJobProgressCachesBulk = origClearBulk;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('resume, retry, and resume-all roll back queued jobs and clear cache when BullMQ requeue fails', async () => {
  const userId = '65b2d8e9f1a23c0012a45bc8';
  const resumeHandler = findJobRouteHandler('post', '/:id/resume');
  const retryHandler = findJobRouteHandler('post', '/:id/retry');
  const resumeAllHandler = findJobRouteHandler('post', '/resume-all');

  const origFind = Job.find;
  const origRequeue = mediaQueue.requeueMediaJob;
  const origRequeueBulk = mediaQueue.requeueMediaJobsBulk;
  const origRemoveQueued = mediaQueue.removeQueuedMediaJob;
  const origRemoveBulk = mediaQueue.removeQueuedMediaJobsBulk;
  const origPublish = mediaQueue.publishJobControl;
  const origClearCache = mediaQueue.clearJobProgressCache;
  const origClearCachesBulk = mediaQueue.clearJobProgressCachesBulk;

  const pausedId = '65b2d8e9f1a23c0012a4a001';
  const failedId = '65b2d8e9f1a23c0012a4a002';
  const activeId = '65b2d8e9f1a23c0012a4a003';
  const secondPausedId = '65b2d8e9f1a23c0012a4a004';

  const store = installMockBatchAndJobStores({
    batches: [
      {
        batchId: 'b-requeue-fail',
        userId,
        totalItems: 2,
        completedItems: 0,
        failedItems: 1,
        status: 'processing',
      },
    ],
    jobs: [
      {
        id: pausedId,
        userId,
        platform: 'youtube',
        useCookies: false,
        status: 'paused',
        batchId: null,
        errorMessage: null,
      },
      {
        id: failedId,
        userId,
        platform: 'youtube',
        useCookies: false,
        status: 'failed',
        batchId: 'b-requeue-fail',
        errorMessage: 'Original error',
      },
      {
        id: activeId,
        userId,
        platform: 'youtube',
        useCookies: false,
        status: 'downloading',
        batchId: 'b-requeue-fail',
        errorMessage: null,
      },
      {
        id: secondPausedId,
        userId,
        platform: 'youtube',
        useCookies: false,
        status: 'paused',
        batchId: null,
        errorMessage: null,
      },
    ],
  });

  // installMockBatchAndJobStores sets Job.find without .sort(), while resume-all calls .sort().lean()
  Job.find = (query) => ({
    select: () => ({
      lean: async () => store.jobDocs.filter((d) => matchesStoreQuery(d, query)),
    }),
    sort: () => ({
      lean: async () => store.jobDocs.filter((d) => matchesStoreQuery(d, query)),
    }),
  });

  const clearedIds = [];
  const clearedBulkSets = [];
  const removedBulkSets = [];

  mediaQueue.clearJobProgressCache = async (id) => {
    clearedIds.push(id);
  };
  mediaQueue.clearJobProgressCachesBulk = async (ids) => {
    clearedBulkSets.push(ids);
  };
  mediaQueue.removeQueuedMediaJobsBulk = async (ids) => {
    removedBulkSets.push(ids);
  };
  mediaQueue.removeQueuedMediaJob = async () => {};
  mediaQueue.publishJobControl = async () => {};
  mediaQueue.requeueMediaJob = async () => {
    throw new Error('Redis unavailable');
  };
  mediaQueue.requeueMediaJobsBulk = async () => {
    throw new Error('Redis bulk unavailable');
  };

  const prevCookiesDir = process.env.COOKIES_DIR;
  const tempCookiesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-requeue-cookies-'));
  await fs.promises.writeFile(
    path.join(tempCookiesDir, 'youtube.txt'),
    '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsample\n'
  );
  process.env.COOKIES_DIR = tempCookiesDir;

  try {
    // 1. POST /:id/resume restores paused on requeue failure
    let errResume = null;
    await resumeHandler(
      { params: { id: pausedId }, user: { id: userId } },
      createMockResponse().res,
      (e) => {
        errResume = e;
      }
    );
    assert.match(errResume?.message || '', /Redis unavailable/);
    assert.equal(store.jobDocs[0].status, 'paused');
    assert.ok(clearedIds.includes(pausedId));

    // 2a. POST /:id/retry from paused restores paused & original useCookies
    clearedIds.length = 0;
    const prevUseCookies = store.jobDocs[0].useCookies;
    let errRetryPaused = null;
    await retryHandler(
      { params: { id: pausedId }, body: { useCookies: true }, user: { id: userId } },
      createMockResponse().res,
      (e) => {
        errRetryPaused = e;
      }
    );
    assert.match(errRetryPaused?.message || '', /Redis unavailable/);
    assert.equal(store.jobDocs[0].status, 'paused');
    assert.equal(store.jobDocs[0].useCookies, prevUseCookies);
    assert.equal(store.jobDocs[0].errorMessage, null);
    assert.ok(clearedIds.includes(pausedId));

    // 2b. POST /:id/retry from failed restores failed & keeps batch rollup accurate
    clearedIds.length = 0;
    let errRetryFailed = null;
    await retryHandler(
      { params: { id: failedId }, body: {}, user: { id: userId } },
      createMockResponse().res,
      (e) => {
        errRetryFailed = e;
      }
    );
    assert.match(errRetryFailed?.message || '', /Redis unavailable/);
    assert.equal(store.jobDocs[1].status, 'failed');
    assert.equal(store.jobDocs[1].errorMessage, 'Original error');
    assert.ok(clearedIds.includes(failedId));
    assert.equal(store.batchDocs[0].failedItems, 1);
    assert.equal(store.batchDocs[0].status, 'processing');

    // 2c. POST /:id/retry from downloading transitions to failed cleanly and updates batch rollup
    clearedIds.length = 0;
    let errRetryActive = null;
    await retryHandler(
      { params: { id: activeId }, body: {}, user: { id: userId } },
      createMockResponse().res,
      (e) => {
        errRetryActive = e;
      }
    );
    assert.match(errRetryActive?.message || '', /Redis unavailable/);
    assert.equal(store.jobDocs[2].status, 'failed');
    assert.match(store.jobDocs[2].errorMessage || '', /Failed to requeue job: Redis unavailable/);
    assert.ok(clearedIds.includes(activeId));
    assert.equal(store.batchDocs[0].failedItems, 2);
    assert.equal(store.batchDocs[0].status, 'failed');

    // 3. POST /resume-all rolls back all still-queued jobs to paused on bulk requeue failure
    let errResumeAll = null;
    await resumeAllHandler(
      { user: { id: userId } },
      createMockResponse().res,
      (e) => {
        errResumeAll = e;
      }
    );
    assert.match(errResumeAll?.message || '', /Redis bulk unavailable/);
    assert.equal(store.jobDocs[0].status, 'paused');
    assert.equal(store.jobDocs[3].status, 'paused');
    assert.deepEqual(removedBulkSets[0], [pausedId, secondPausedId]);
    assert.deepEqual(clearedBulkSets[0], [pausedId, secondPausedId]);
  } finally {
    if (prevCookiesDir === undefined) delete process.env.COOKIES_DIR;
    else process.env.COOKIES_DIR = prevCookiesDir;
    store.restore();
    Job.find = origFind;
    mediaQueue.requeueMediaJob = origRequeue;
    mediaQueue.requeueMediaJobsBulk = origRequeueBulk;
    mediaQueue.removeQueuedMediaJob = origRemoveQueued;
    mediaQueue.removeQueuedMediaJobsBulk = origRemoveBulk;
    mediaQueue.publishJobControl = origPublish;
    mediaQueue.clearJobProgressCache = origClearCache;
    mediaQueue.clearJobProgressCachesBulk = origClearCachesBulk;
    await fs.promises.rm(tempCookiesDir, { recursive: true, force: true });
  }
});
