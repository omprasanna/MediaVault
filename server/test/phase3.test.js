const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const User = require('../src/models/User');
const {
  getJwtSecret,
  parseDurationToMs,
  requireAuth,
} = require('../src/middleware/auth');
const authRouter = require('../src/routes/auth');
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
