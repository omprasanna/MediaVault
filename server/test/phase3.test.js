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
const { validateNetscapeCookies } = require('../src/utils/cookieValidator');
const { mapInspectResponse } = require('../src/utils/formatMapper');

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

  const originalFindById = User.findById;
  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: { toString: () => '65b2d8e9f1a23c0012a45bc8' },
        email: 'admin@mediavault.local',
        role: 'admin',
      }),
    }),
  });

  try {
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
