const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Duplex, PassThrough } = require('node:stream');
const jwt = require('jsonwebtoken');
const { MongoServerError } = require('mongodb');

const Cookie = require('../src/models/Cookie');
const Job = require('../src/models/Job');
const User = require('../src/models/User');
const mediaQueue = require('../src/queues/mediaQueue');
const {
  getJwtSecret,
  requireAdmin,
  requireAuth,
  validateJwtSecret,
} = require('../src/middleware/auth');
const authRouter = require('../src/routes/auth');
const cookiesRouter = require('../src/routes/cookies');
const proxyRouter = require('../src/routes/proxy');
const systemRouter = require('../src/routes/system');
const { remoteTunnel } = require('../src/utils/remoteTunnel');
const {
  assertPublicUrl,
  createPinnedLookup,
  isPrivateIp,
  requestPublicUrl,
  requestResolvedPublicUrl,
  resolvePublicUrl,
} = require('../src/utils/ssrf');
const {
  buildProxyChildEnv,
  createPinnedSsrfProxy,
  parseConnectAuthority,
  redactProxyCredentials,
} = require('../src/utils/ssrfProxy');
const { buildYtDlpJobArgs } = require('../src/utils/workerHelpers');
const { buildInspectArgs, inspectMediaUrl, spawnYtDlp } = require('../src/utils/ytdlp');

const VALID_TEST_JWT_SECRET =
  'b4c3a2f1e0d9c8b7a69584736251403f2e1d0c9b8a79685746352413021f1e0d';

function getAuthRouteHandler(method, routePath) {
  const layer = authRouter.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} /api/auth${routePath} route handler`);
  return layer.route.stack[0].handle;
}

function invokeExpressHandler(handler, req) {
  return new Promise((resolve) => {
    let settled = false;
    const cookiesSet = [];
    const res = {
      statusCode: 200,
      cookie(name, value, options) {
        cookiesSet.push({ name, value, options });
      },
      status(code) {
        res.statusCode = code;
        return res;
      },
      json(payload) {
        if (!settled) {
          settled = true;
          resolve({ statusCode: res.statusCode, payload, cookies: cookiesSet, error: null });
        }
        return res;
      },
    };

    Promise.resolve(
      handler(req, res, (err) => {
        if (!settled) {
          settled = true;
          resolve({ statusCode: res.statusCode, payload: null, cookies: cookiesSet, error: err || null });
        }
      })
    ).catch((err) => {
      if (!settled) {
        settled = true;
        resolve({ statusCode: res.statusCode, payload: null, cookies: cookiesSet, error: err });
      }
    });
  });
}

function makeDuplicateKeyError({ indexName, keyPattern, keyValue }) {
  return new MongoServerError({
    ok: 0,
    code: 11000,
    codeName: 'DuplicateKey',
    errmsg: `E11000 duplicate key error collection: mediavault.users index: ${indexName} dup key: ${JSON.stringify(keyValue)}`,
    keyPattern,
    keyValue,
  });
}

function installMockUserStore({ failAdminIndexFirstOnSameEmail = false } = {}) {
  const origFindOne = User.findOne;
  const origExists = User.exists;
  const origCreate = User.create;

  const docs = [];
  let nextId = 1;

  const yieldAsync = () => new Promise((resolve) => setImmediate(resolve));

  User.findOne = (query) => ({
    select: () => ({
      lean: async () => {
        await yieldAsync();
        const found = docs.find((d) => d.email === query.email);
        return found ? { _id: found._id } : null;
      },
    }),
  });

  User.exists = async () => {
    await yieldAsync();
    return docs.length > 0 ? { _id: docs[0]._id } : null;
  };

  User.create = async (doc) => {
    await yieldAsync();
    const email = String(doc.email).trim().toLowerCase();
    const role = doc.role || 'user';

    const emailConflict = docs.some((d) => d.email === email);
    const adminConflict = role === 'admin' && docs.some((d) => d.role === 'admin');

    if (failAdminIndexFirstOnSameEmail && adminConflict) {
      throw makeDuplicateKeyError({
        indexName: 'unique_admin_role',
        keyPattern: { role: 1 },
        keyValue: { role: 'admin' },
      });
    }

    if (emailConflict) {
      throw makeDuplicateKeyError({
        indexName: 'email_1',
        keyPattern: { email: 1 },
        keyValue: { email },
      });
    }

    if (adminConflict) {
      throw makeDuplicateKeyError({
        indexName: 'unique_admin_role',
        keyPattern: { role: 1 },
        keyValue: { role: 'admin' },
      });
    }

    const saved = {
      _id: { toString: () => `65b2d8e9f1a23c0012a4${String(nextId++).padStart(4, '0')}` },
      email,
      passwordHash: doc.passwordHash,
      role,
    };
    docs.push(saved);
    return saved;
  };

  return {
    docs,
    restore() {
      User.findOne = origFindOne;
      User.exists = origExists;
      User.create = origCreate;
    },
  };
}

function createMockTransport(responder) {
  const calls = [];
  return {
    calls,
    request(requestOptions, responseCallback) {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = (err) => {
        req.destroyed = true;
        if (err) {
          process.nextTick(() => req.emit('error', err));
        }
      };

      const callRecord = {
        requestOptions,
        socketAddressUsed: null,
      };
      calls.push(callRecord);

      req.end = () => {
        process.nextTick(() => {
          if (req.destroyed) return;
          if (requestOptions.signal?.aborted) {
            const abortErr = new Error('The operation was aborted.');
            abortErr.name = 'AbortError';
            abortErr.code = 'ABORT_ERR';
            req.emit('error', abortErr);
            return;
          }

          const spec = responder(requestOptions, req);
          if (!spec) return;

          if (spec.socketRemoteAddress !== undefined) {
            const fakeSocket = new EventEmitter();
            fakeSocket.remoteAddress = spec.socketRemoteAddress;
            fakeSocket.destroyed = false;
            fakeSocket.destroy = (err) => {
              fakeSocket.destroyed = true;
              if (err) {
                req.destroy(err);
              }
            };
            callRecord.socketAddressUsed = fakeSocket.remoteAddress;
            req.emit('socket', fakeSocket);
            if (fakeSocket.destroyed || req.destroyed) {
              return;
            }
          }

          if (spec.error) {
            req.emit('error', spec.error);
            return;
          }

          const res = new PassThrough();
          res.statusCode = spec.statusCode ?? 200;
          res.headers = spec.headers ?? {};
          res.socket = spec.resSocket ?? null;

          if (typeof responseCallback === 'function') {
            responseCallback(res);
          } else {
            req.emit('response', res);
          }

          if (!res.destroyed) {
            if (spec.body !== undefined) {
              res.end(spec.body);
            } else {
              res.end();
            }
          }
        });
      };

      return req;
    },
  };
}

async function readStreamText(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function runApiStartupWithEnv(envOverrides) {
  const apiEntry = path.resolve(__dirname, '..', 'src', 'api.js');
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [apiEntry], {
      cwd: os.tmpdir(), // Ensure dotenv does not load workspace .env
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for api.js startup failure'));
    }, 10000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('User schema enforces partial unique index for sole admin and defaults role to user', () => {
  assert.equal(User.schema.path('role').defaultValue, 'user');
  const indexes = User.schema.indexes();
  const adminIndex = indexes.find(
    ([fields, opts]) =>
      fields &&
      fields.role === 1 &&
      opts &&
      opts.unique === true &&
      opts.partialFilterExpression &&
      opts.partialFilterExpression.role === 'admin'
  );
  assert.ok(adminIndex, 'Expected partial unique index on { role: 1 } for role: "admin"');
});

test('POST /api/auth/register assigns admin to exactly one user under concurrent registration', async () => {
  const prevAllow = process.env.ALLOW_REGISTRATION;
  process.env.ALLOW_REGISTRATION = 'true';
  const store = installMockUserStore();

  try {
    const registerHandler = getAuthRouteHandler('post', '/register');
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        invokeExpressHandler(registerHandler, {
          body: {
            email: `concurrent${idx}@mediavault.local`,
            password: 'StrongPassword123!',
          },
        })
      )
    );

    for (const res of results) {
      assert.equal(res.error, null);
      assert.equal(res.statusCode, 201);
      assert.equal(res.payload.success, true);
    }

    const roles = results.map((r) => r.payload.user.role);
    assert.equal(roles.filter((r) => r === 'admin').length, 1);
    assert.equal(roles.filter((r) => r === 'user').length, 4);
    assert.equal(store.docs.filter((d) => d.role === 'admin').length, 1);
    assert.equal(store.docs.length, 5);
  } finally {
    store.restore();
    if (prevAllow === undefined) delete process.env.ALLOW_REGISTRATION;
    else process.env.ALLOW_REGISTRATION = prevAllow;
  }
});

test('POST /api/auth/register handles simultaneous same-email registration safely regardless of index check order', async () => {
  const prevAllow = process.env.ALLOW_REGISTRATION;
  process.env.ALLOW_REGISTRATION = 'true';

  for (const failAdminIndexFirstOnSameEmail of [false, true]) {
    const store = installMockUserStore({ failAdminIndexFirstOnSameEmail });
    try {
      const registerHandler = getAuthRouteHandler('post', '/register');
      const results = await Promise.all([
        invokeExpressHandler(registerHandler, {
          body: { email: 'race@mediavault.local', password: 'StrongPassword123!' },
        }),
        invokeExpressHandler(registerHandler, {
          body: { email: 'race@mediavault.local', password: 'StrongPassword123!' },
        }),
      ]);

      const successes = results.filter((r) => r.error === null);
      const conflicts = results.filter((r) => r.error !== null);

      assert.equal(successes.length, 1);
      assert.equal(successes[0].statusCode, 201);
      assert.equal(successes[0].payload.user.role, 'admin');

      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].error.statusCode, 409);
      assert.equal(conflicts[0].error.code, 'EMAIL_EXISTS');
      assert.equal(store.docs.length, 1);
      assert.equal(store.docs[0].role, 'admin');
    } finally {
      store.restore();
    }
  }

  if (prevAllow === undefined) delete process.env.ALLOW_REGISTRATION;
  else process.env.ALLOW_REGISTRATION = prevAllow;
});

test('POST /api/auth/register assigns admin to first user, user to subsequent users, and rejects duplicates', async () => {
  const prevAllow = process.env.ALLOW_REGISTRATION;
  process.env.ALLOW_REGISTRATION = 'true';
  const store = installMockUserStore();

  try {
    const registerHandler = getAuthRouteHandler('post', '/register');

    const first = await invokeExpressHandler(registerHandler, {
      body: { email: 'first@mediavault.local', password: 'StrongPassword123!' },
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.payload.user.role, 'admin');

    const second = await invokeExpressHandler(registerHandler, {
      body: { email: 'second@mediavault.local', password: 'StrongPassword123!' },
    });
    assert.equal(second.statusCode, 201);
    assert.equal(second.payload.user.role, 'user');

    const dup = await invokeExpressHandler(registerHandler, {
      body: { email: 'FIRST@mediavault.local', password: 'StrongPassword123!' },
    });
    assert.equal(dup.error.statusCode, 409);
    assert.equal(dup.error.code, 'EMAIL_EXISTS');
  } finally {
    store.restore();
    if (prevAllow === undefined) delete process.env.ALLOW_REGISTRATION;
    else process.env.ALLOW_REGISTRATION = prevAllow;
  }
});

test('POST /api/auth/register assigns user role when a non-admin user already exists', async () => {
  const prevAllow = process.env.ALLOW_REGISTRATION;
  process.env.ALLOW_REGISTRATION = 'true';
  const store = installMockUserStore();
  store.docs.push({
    _id: { toString: () => '65b2d8e9f1a23c0012a49999' },
    email: 'existing-user@mediavault.local',
    passwordHash: 'hash',
    role: 'user',
  });

  try {
    const registerHandler = getAuthRouteHandler('post', '/register');
    const res = await invokeExpressHandler(registerHandler, {
      body: { email: 'new@mediavault.local', password: 'StrongPassword123!' },
    });
    assert.equal(res.error, null);
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.user.role, 'user');
  } finally {
    store.restore();
    if (prevAllow === undefined) delete process.env.ALLOW_REGISTRATION;
    else process.env.ALLOW_REGISTRATION = prevAllow;
  }
});

test('validateJwtSecret and getJwtSecret reject missing, fallback, placeholder, and weak secrets', () => {
  const prevSecret = process.env.JWT_SECRET;

  try {
    const badSecrets = [
      undefined,
      '',
      '   ',
      'mediavault-dev-secret',
      'MEDIAVAULT-DEV-SECRET',
      'replace-with-a-strong-random-secret',
      'changeme',
      'your-jwt-secret',
      'secret',
      'short-secret',
      'a'.repeat(64),
      'ab'.repeat(32),
    ];

    for (const bad of badSecrets) {
      assert.throws(() => validateJwtSecret(bad), /JWT_SECRET/);
      if (bad === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = bad;
      assert.throws(() => getJwtSecret(), /JWT_SECRET/);
    }

    const strong = crypto.randomBytes(32).toString('hex');
    process.env.JWT_SECRET = `  ${strong}  `;
    assert.equal(validateJwtSecret(), strong);
    assert.equal(getJwtSecret(), strong);
  } finally {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  }
});

test('requireAuth and login never accept or fall back to mediavault-dev-secret', async () => {
  const prevSecret = process.env.JWT_SECRET;
  const origFindById = User.findById;

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
    process.env.JWT_SECRET = VALID_TEST_JWT_SECRET;
    const forgedToken = jwt.sign(
      { sub: '65b2d8e9f1a23c0012a45bc8', email: 'admin@mediavault.local', role: 'admin' },
      'mediavault-dev-secret',
      { expiresIn: '1h' }
    );

    let capturedErr = null;
    await requireAuth({ cookies: { jwt: forgedToken } }, {}, (err) => {
      capturedErr = err;
    });
    assert.equal(capturedErr.statusCode, 401);
    assert.equal(capturedErr.code, 'UNAUTHORIZED');

    delete process.env.JWT_SECRET;
    let configErr = null;
    await requireAuth({ cookies: { jwt: forgedToken } }, {}, (err) => {
      configErr = err;
    });
    assert.ok(configErr instanceof Error);
    assert.match(configErr.message, /JWT_SECRET/);
    assert.notEqual(configErr.code, 'UNAUTHORIZED');

    const loginHandler = getAuthRouteHandler('post', '/login');
    const origFindOne = User.findOne;
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash('StrongPassword123!', 4);
    User.findOne = async () => ({
      _id: { toString: () => '65b2d8e9f1a23c0012a45bc8' },
      email: 'admin@mediavault.local',
      role: 'admin',
      passwordHash,
      lastLoginAt: null,
      save: async () => {},
    });

    try {
      const loginResult = await invokeExpressHandler(loginHandler, {
        body: { email: 'admin@mediavault.local', password: 'StrongPassword123!' },
      });
      assert.ok(loginResult.error instanceof Error);
      assert.match(loginResult.error.message, /JWT_SECRET/);
      assert.equal(loginResult.cookies.length, 0);
    } finally {
      User.findOne = origFindOne;
    }
  } finally {
    User.findById = origFindById;
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  }
});

test('api.js exits immediately on startup when JWT_SECRET is missing or a known placeholder', async () => {
  const cases = [
    { JWT_SECRET: undefined },
    { JWT_SECRET: 'mediavault-dev-secret' },
    { JWT_SECRET: 'replace-with-a-strong-random-secret' },
  ];

  for (const envOverrides of cases) {
    const result = await runApiStartupWithEnv(envOverrides);
    assert.notEqual(result.code, 0, `Expected non-zero exit for ${JSON.stringify(envOverrides)}`);
    assert.match(result.stderr, /JWT_SECRET/);
  }
});

test('isPrivateIp and resolvePublicUrl block extended reserved ranges, trailing-dot restricted hosts, and mixed DNS records', async () => {
  const additionalPrivateIps = [
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '64:ff9b::127.0.0.1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::',
    'fec0::1',
    'fe80::1%eth0',
    '3fff::1',
  ];

  for (const ip of additionalPrivateIps) {
    assert.equal(isPrivateIp(ip), true, `Expected ${ip} to be flagged private`);
  }

  assert.equal(isPrivateIp('93.184.216.34'), false);
  assert.equal(isPrivateIp('2606:2800:220:1:248:1893:25c8:1946'), false);

  await assert.rejects(() => assertPublicUrl('http://localhost./secret'), { code: 'INVALID_URL' });
  await assert.rejects(() => assertPublicUrl('http://api.internal./secret'), { code: 'INVALID_URL' });

  await assert.rejects(
    () =>
      resolvePublicUrl('https://cdn.example.com/video.mp4', {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ],
      }),
    { code: 'INVALID_URL' }
  );
});

test('createPinnedLookup pins exact addresses, supports all/family options, and rejects mismatched hosts', async () => {
  assert.throws(() => createPinnedLookup('cdn.example.com', [{ address: '127.0.0.1', family: 4 }]), {
    code: 'INVALID_URL',
  });

  const pinned = createPinnedLookup('cdn.example.com', [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);

  const single = await new Promise((resolve, reject) => {
    pinned('cdn.example.com', (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: '93.184.216.34', family: 4 });

  const allRecords = await new Promise((resolve, reject) => {
    pinned('CDN.EXAMPLE.COM', { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
  assert.deepEqual(allRecords, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);

  const ipv6Only = await new Promise((resolve, reject) => {
    pinned('cdn.example.com', { family: 6 }, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(ipv6Only, {
    address: '2606:2800:220:1:248:1893:25c8:1946',
    family: 6,
  });

  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        pinned('evil.example.net', (err, address) => {
          if (err) reject(err);
          else resolve(address);
        });
      }),
    { code: 'INVALID_URL' }
  );

  const ipv4OnlyPinned = createPinnedLookup('cdn.example.com', [
    { address: '93.184.216.34', family: 4 },
  ]);
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        ipv4OnlyPinned('cdn.example.com', { family: 6 }, (err, address) => {
          if (err) reject(err);
          else resolve(address);
        });
      }),
    { code: 'ENOTFOUND' }
  );
});

test('requestResolvedPublicUrl prevents DNS rebinding within a single request and pins SNI', async () => {
  let lookupCalls = 0;
  const rebindingLookup = async () => {
    lookupCalls += 1;
    if (lookupCalls === 1) {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    return [{ address: '127.0.0.1', family: 4 }];
  };

  let observedLookupResultAll = null;
  let observedLookupResultSingle = null;
  const transport = createMockTransport((opts) => {
    assert.equal(opts.agent, false);
    assert.equal(opts.servername, 'rebind.example.test');
    assert.equal(typeof opts.lookup, 'function');

    opts.lookup('rebind.example.test', { all: true }, (err, records) => {
      assert.ifError(err);
      observedLookupResultAll = records;
    });
    opts.lookup('rebind.example.test', 4, (err, address, family) => {
      assert.ifError(err);
      observedLookupResultSingle = { address, family };
    });

    return {
      statusCode: 200,
      headers: { 'content-type': 'video/mp4' },
      socketRemoteAddress: '93.184.216.34',
      body: 'pinned-ok',
    };
  });

  const response = await requestPublicUrl('https://rebind.example.test/video.mp4', {
    lookup: rebindingLookup,
    transport,
  });

  // Allow process.nextTick callbacks inside opts.lookup checks to flush.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lookupCalls, 1);
  assert.deepEqual(observedLookupResultAll, [{ address: '93.184.216.34', family: 4 }]);
  assert.deepEqual(observedLookupResultSingle, { address: '93.184.216.34', family: 4 });
  assert.equal(await readStreamText(response.body), 'pinned-ok');
});

test('requestResolvedPublicUrl destroys socket and rejects if connected peer IP is private or unvalidated', async () => {
  const privateSocketTransport = createMockTransport(() => ({
    statusCode: 200,
    socketRemoteAddress: '127.0.0.1',
    body: 'should-not-arrive',
  }));

  await assert.rejects(
    () =>
      requestPublicUrl('https://cdn.example.com/video.mp4', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: privateSocketTransport,
      }),
    { code: 'INVALID_URL' }
  );

  const mismatchedSocketTransport = createMockTransport(() => ({
    statusCode: 200,
    socketRemoteAddress: '142.250.190.46',
    body: 'should-not-arrive',
  }));

  await assert.rejects(
    () =>
      requestPublicUrl('https://cdn.example.com/video.mp4', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: mismatchedSocketTransport,
      }),
    { code: 'INVALID_URL' }
  );

  const resolved = await resolvePublicUrl('https://cdn.example.com/video.mp4', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(resolved.addresses[0].address, '93.184.216.34');
  await assert.rejects(
    () =>
      requestResolvedPublicUrl(
        { ...resolved, addresses: [{ address: '10.0.0.1', family: 4 }] },
        { transport: privateSocketTransport }
      ),
    { code: 'INVALID_URL' }
  );
});

test('fetchWithSsrfGuard blocks loopback server directly and via redirect without hitting loopback socket', async () => {
  let loopbackHits = 0;
  const server = http.createServer((_req, res) => {
    loopbackHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('secret-local-data');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      () => proxyRouter.fetchWithSsrfGuard(`http://127.0.0.1:${port}/secret`),
      { code: 'INVALID_URL' }
    );

    await assert.rejects(
      () =>
        proxyRouter.fetchWithSsrfGuard(`http://local-rebind.example.test:${port}/secret`, {
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        }),
      { code: 'INVALID_URL' }
    );

    const redirectToLoopbackTransport = createMockTransport(() => ({
      statusCode: 302,
      headers: { location: `http://127.0.0.1:${port}/secret` },
      socketRemoteAddress: '93.184.216.34',
    }));

    await assert.rejects(
      () =>
        proxyRouter.fetchWithSsrfGuard('https://cdn.example.com/start', {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          transport: redirectToLoopbackTransport,
        }),
      { code: 'INVALID_URL' }
    );

    assert.equal(loopbackHits, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fetchWithSsrfGuard blocks unsafe redirect targets and DNS rebinding across redirects', async () => {
  const unsafeRedirects = [
    {
      name: 'hostname resolving to IMDS',
      location: 'http://imds.example.test/latest/meta-data/',
      lookup: async (host) =>
        host === 'imds.example.test'
          ? [{ address: '169.254.169.254', family: 4 }]
          : [{ address: '93.184.216.34', family: 4 }],
    },
    {
      name: 'non-http scheme',
      location: 'file:///etc/passwd',
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    },
    {
      name: 'embedded credentials',
      location: 'https://user:pass@cdn.example.com/video.mp4',
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    },
  ];

  for (const scenario of unsafeRedirects) {
    const transport = createMockTransport(() => ({
      statusCode: 302,
      headers: { location: scenario.location },
      socketRemoteAddress: '93.184.216.34',
    }));

    await assert.rejects(
      () =>
        proxyRouter.fetchWithSsrfGuard('https://cdn.example.com/start', {
          lookup: scenario.lookup,
          transport,
        }),
      { code: 'INVALID_URL' },
      `Expected redirect to ${scenario.name} to be blocked`
    );
    assert.equal(transport.calls.length, 1);
  }

  // Same-hostname DNS rebinding across redirect hop
  let sameHostLookupCount = 0;
  const sameHostTransport = createMockTransport(() => ({
    statusCode: 302,
    headers: { location: '/step2' },
    socketRemoteAddress: '93.184.216.34',
  }));
  await assert.rejects(
    () =>
      proxyRouter.fetchWithSsrfGuard('https://rebind-hop.example.test/step1', {
        lookup: async () => {
          sameHostLookupCount += 1;
          return sameHostLookupCount === 1
            ? [{ address: '93.184.216.34', family: 4 }]
            : [{ address: '127.0.0.1', family: 4 }];
        },
        transport: sameHostTransport,
      }),
    { code: 'INVALID_URL' }
  );
  assert.equal(sameHostLookupCount, 2);
  assert.equal(sameHostTransport.calls.length, 1);

  // Redirect hop target attempts rebinding after first DNS check
  let bLookupCount = 0;
  const redirectTargetRebindTransport = createMockTransport((opts) => {
    if (opts.hostname === 'a.example.com') {
      return {
        statusCode: 302,
        headers: { location: 'https://b.example.net/media.mp4' },
        socketRemoteAddress: '93.184.216.34',
      };
    }

    let pinnedIps = null;
    opts.lookup('b.example.net', { all: true }, (err, recs) => {
      assert.ifError(err);
      pinnedIps = recs;
    });
    assert.equal(bLookupCount, 1);

    return {
      statusCode: 200,
      headers: { 'content-type': 'video/mp4' },
      socketRemoteAddress: '142.250.190.46',
      body: 'ok-hop-pinned',
    };
  });

  const okRes = await proxyRouter.fetchWithSsrfGuard('https://a.example.com/start', {
    lookup: async (host) => {
      if (host === 'a.example.com') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      bLookupCount += 1;
      return bLookupCount === 1
        ? [{ address: '142.250.190.46', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    },
    transport: redirectTargetRebindTransport,
  });

  assert.equal(bLookupCount, 1);
  assert.equal(await readStreamText(okRes.body), 'ok-hop-pinned');
});

test('fetchWithSsrfGuard handles valid multi-hop redirects, strips sensitive headers, and enforces hop limits', async () => {
  const seenRequests = [];
  const transport = createMockTransport((opts) => {
    seenRequests.push({
      protocol: opts.protocol,
      hostname: opts.hostname,
      path: opts.path,
      method: opts.method,
      headers: opts.headers,
    });

    if (opts.hostname === 'media.example.com' && opts.path === '/start') {
      return {
        statusCode: 302,
        headers: { location: '/relative-next' },
        socketRemoteAddress: '93.184.216.34',
      };
    }
    if (opts.hostname === 'media.example.com' && opts.path === '/relative-next') {
      return {
        statusCode: 303,
        headers: { location: 'https://cdn.otherdomain.net/final.mp4' },
        socketRemoteAddress: '93.184.216.34',
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'video/mp4' },
      socketRemoteAddress: '142.250.190.46',
      body: 'streamed-video-bytes',
    };
  });

  const upstream = await proxyRouter.fetchWithSsrfGuard('https://media.example.com/start', {
    method: 'POST',
    headers: {
      Cookie: 'session=abc',
      Authorization: 'Bearer secret-token',
      'User-Agent': 'MediaVaultTest/1.0',
    },
    lookup: async (host) =>
      host === 'media.example.com'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '142.250.190.46', family: 4 }],
    transport,
  });

  assert.equal(upstream.status, 200);
  assert.equal(await readStreamText(upstream.body), 'streamed-video-bytes');
  assert.equal(seenRequests.length, 3);
  assert.equal(seenRequests[1].headers.Cookie, 'session=abc');
  assert.equal(seenRequests[1].headers.Authorization, 'Bearer secret-token');
  assert.equal(seenRequests[2].method, 'GET');
  assert.equal(seenRequests[2].headers.Cookie, undefined);
  assert.equal(seenRequests[2].headers.Authorization, undefined);
  assert.equal(seenRequests[2].headers['User-Agent'], 'MediaVaultTest/1.0');

  // HTTPS -> HTTP downgrade on same root domain must also strip Cookie & Authorization
  const downgradeSeen = [];
  const downgradeTransport = createMockTransport((opts) => {
    downgradeSeen.push({ protocol: opts.protocol, headers: opts.headers });
    if (opts.protocol === 'https:') {
      return {
        statusCode: 302,
        headers: { location: 'http://sub.example.com/insecure.mp4' },
        socketRemoteAddress: '93.184.216.34',
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'video/mp4' },
      socketRemoteAddress: '93.184.216.34',
      body: 'downgraded-ok',
    };
  });

  const downgradedRes = await proxyRouter.fetchWithSsrfGuard('https://media.example.com/start', {
    headers: { cookie: 'sid=1', authorization: 'Bearer tok' },
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: downgradeTransport,
  });
  assert.equal(await readStreamText(downgradedRes.body), 'downgraded-ok');
  assert.equal(downgradeSeen[1].headers.cookie, undefined);
  assert.equal(downgradeSeen[1].headers.authorization, undefined);

  // Missing Location header -> 502 PROXY_UPSTREAM_ERROR
  const missingLocationTransport = createMockTransport(() => ({
    statusCode: 302,
    headers: {},
    socketRemoteAddress: '93.184.216.34',
  }));
  await assert.rejects(
    () =>
      proxyRouter.fetchWithSsrfGuard('https://media.example.com/start', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: missingLocationTransport,
      }),
    { statusCode: 502, code: 'PROXY_UPSTREAM_ERROR' }
  );

  // Exceeding MAX_REDIRECTS -> 502 PROXY_UPSTREAM_ERROR
  const loopTransport = createMockTransport(() => ({
    statusCode: 302,
    headers: { location: 'https://media.example.com/loop' },
    socketRemoteAddress: '93.184.216.34',
  }));
  await assert.rejects(
    () =>
      proxyRouter.fetchWithSsrfGuard('https://media.example.com/loop', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: loopTransport,
      }),
    { statusCode: 502, code: 'PROXY_UPSTREAM_ERROR' }
  );
  assert.equal(loopTransport.calls.length, 6);
});

function getProxyAuthHeader(proxyUrl) {
  const parsed = new URL(proxyUrl);
  return `Basic ${Buffer.from(
    `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
    'utf8'
  ).toString('base64')}`;
}

function sendHttpThroughProxy({ port, authHeader, targetUrl, headers = {} }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (authHeader !== undefined) {
      reqHeaders['Proxy-Authorization'] = authHeader;
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: targetUrl,
        headers: reqHeaders,
      },
      async (res) => {
        try {
          const body = await readStreamText(res);
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        } catch (err) {
          reject(err);
        }
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function sendConnectThroughProxy({ port, authHeader, authority, payload }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (authHeader !== undefined) {
      headers['Proxy-Authorization'] = authHeader;
    }

    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: authority,
      headers,
    });

    req.on('connect', (res, socket, head) => {
      const chunks = [];
      if (head && head.length > 0) {
        chunks.push(head);
      }
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      if (payload !== undefined) {
        socket.end(payload);
      }
    });

    req.on('response', async (res) => {
      try {
        const body = await readStreamText(res);
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
    req.end();
  });
}

function createFakeDuplexSocket({ remoteAddress } = {}) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      outgoing.write(chunk, encoding, callback);
    },
    final(callback) {
      outgoing.end(callback);
    },
  });
  incoming.on('data', (chunk) => socket.push(chunk));
  incoming.on('end', () => socket.push(null));
  socket.remoteAddress = remoteAddress;
  socket.incoming = incoming;
  socket.outgoing = outgoing;
  return socket;
}

async function assertPortClosed(port) {
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port });
        sock.once('connect', () => {
          sock.destroy();
          resolve('connected');
        });
        sock.once('error', reject);
      }),
    (err) => err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')
  );
}

test('createPinnedSsrfProxy enforces Basic auth, pins DNS across HTTP and CONNECT, and blocks private/rebind targets', async () => {
  assert.deepEqual(parseConnectAuthority('www.youtube.com:443'), {
    host: 'www.youtube.com',
    port: 443,
  });
  assert.deepEqual(parseConnectAuthority('[2606:2800::1]:8443'), {
    host: '2606:2800::1',
    port: 8443,
  });
  assert.equal(parseConnectAuthority('bad-host'), null);
  assert.equal(parseConnectAuthority('example.com:99999'), null);

  let loopbackHits = 0;
  const loopbackServer = http.createServer((_req, res) => {
    loopbackHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('local-secret');
  });
  await new Promise((resolve) => loopbackServer.listen(0, '127.0.0.1', resolve));
  const loopbackPort = loopbackServer.address().port;

  let lookupCalls = 0;
  const connectRecords = [];
  const transport = createMockTransport((opts) => {
    assert.equal(opts.headers['proxy-authorization'], undefined);
    if (opts.hostname === 'redirect-loop.example.test') {
      return {
        statusCode: 302,
        headers: { location: `http://127.0.0.1:${loopbackPort}/secret` },
        socketRemoteAddress: '93.184.216.34',
      };
    }
    if (opts.hostname === 'redirect-scheme.example.test') {
      return {
        statusCode: 302,
        headers: { location: 'file:///etc/passwd' },
        socketRemoteAddress: '93.184.216.34',
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      socketRemoteAddress: '93.184.216.34',
      body: 'http-pinned-ok',
    };
  });

  const proxy = await createPinnedSsrfProxy({
    pinnedHosts: new Map([
      ['pinned.example.test', [{ address: '93.184.216.34', family: 4 }]],
    ]),
    lookup: async (hostname) => {
      lookupCalls += 1;
      if (hostname === 'imds.example.test') {
        return [{ address: '169.254.169.254', family: 4 }];
      }
      if (hostname === 'rebind-connect.example.test') {
        return lookupCalls === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      }
      if (
        hostname === 'redirect-loop.example.test' ||
        hostname === 'redirect-scheme.example.test'
      ) {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      // If pinned.example.test were looked up again, return loopback to prove pin held.
      return [{ address: '127.0.0.1', family: 4 }];
    },
    connect: ({ host, port, family }) => {
      connectRecords.push({ host, port, family });
      const sock = createFakeDuplexSocket({ remoteAddress: host });
      process.nextTick(() => {
        sock.emit('connect');
        sock.outgoing.on('data', (chunk) => {
          sock.incoming.end(`tunnel:${chunk.toString('utf8')}`);
        });
      });
      return sock;
    },
    transport,
  });

  const authHeader = getProxyAuthHeader(proxy.proxyUrl);

  try {
    // 1. Missing/invalid Proxy-Authorization -> 407 on HTTP and CONNECT
    const unauthHttp = await sendHttpThroughProxy({
      port: proxy.port,
      targetUrl: 'http://pinned.example.test/video',
    });
    assert.equal(unauthHttp.statusCode, 407);

    const badAuthConnect = await sendConnectThroughProxy({
      port: proxy.port,
      authHeader: 'Basic d3Jvbmc6dG9rZW4=',
      authority: 'pinned.example.test:443',
    });
    assert.equal(badAuthConnect.statusCode, 407);

    // 2. Pre-pinned host works for HTTP and CONNECT with 0 extra DNS lookups
    const lookupBeforePinned = lookupCalls;
    const pinnedHttp = await sendHttpThroughProxy({
      port: proxy.port,
      authHeader,
      targetUrl: 'http://pinned.example.test/video',
    });
    assert.equal(pinnedHttp.statusCode, 200);
    assert.equal(pinnedHttp.body, 'http-pinned-ok');

    const pinnedConnect = await sendConnectThroughProxy({
      port: proxy.port,
      authHeader,
      authority: 'pinned.example.test:443',
      payload: 'ping',
    });
    assert.equal(pinnedConnect.statusCode, 200);
    assert.equal(pinnedConnect.body, 'tunnel:ping');
    assert.equal(lookupCalls, lookupBeforePinned);
    assert.equal(connectRecords[connectRecords.length - 1].host, '93.184.216.34');

    // 3. Unpinned host DNS rebinding on CONNECT resolves once and reuses pin
    lookupCalls = 0;
    const c1 = await sendConnectThroughProxy({
      port: proxy.port,
      authHeader,
      authority: 'rebind-connect.example.test:443',
      payload: 'one',
    });
    const c2 = await sendConnectThroughProxy({
      port: proxy.port,
      authHeader,
      authority: 'rebind-connect.example.test:443',
      payload: 'two',
    });
    assert.equal(c1.statusCode, 200);
    assert.equal(c1.body, 'tunnel:one');
    assert.equal(c2.statusCode, 200);
    assert.equal(c2.body, 'tunnel:two');
    assert.equal(lookupCalls, 1);
    assert.equal(connectRecords[connectRecords.length - 1].host, '93.184.216.34');

    // 4. Direct loopback, IPv6 loopback, and IMDS blocked with 403
    const directLoop = await sendHttpThroughProxy({
      port: proxy.port,
      authHeader,
      targetUrl: `http://127.0.0.1:${loopbackPort}/secret`,
    });
    assert.equal(directLoop.statusCode, 403);

    const connectLoop = await sendConnectThroughProxy({
      port: proxy.port,
      authHeader,
      authority: `127.0.0.1:${loopbackPort}`,
    });
    assert.equal(connectLoop.statusCode, 403);

    const connectV6Loop = await sendConnectThroughProxy({
      port: proxy.port,
      authHeader,
      authority: '[::1]:443',
    });
    assert.equal(connectV6Loop.statusCode, 403);

    const connectImds = await sendConnectThroughProxy({
      port: proxy.port,
      authHeader,
      authority: 'imds.example.test:443',
    });
    assert.equal(connectImds.statusCode, 403);

    // 5. Plain HTTP redirects to loopback or file:// blocked with 403
    const redirLoop = await sendHttpThroughProxy({
      port: proxy.port,
      authHeader,
      targetUrl: 'http://redirect-loop.example.test/start',
    });
    assert.equal(redirLoop.statusCode, 403);

    const redirScheme = await sendHttpThroughProxy({
      port: proxy.port,
      authHeader,
      targetUrl: 'http://redirect-scheme.example.test/start',
    });
    assert.equal(redirScheme.statusCode, 403);

    assert.equal(loopbackHits, 0);
    assert.ok(proxy.getBlockedCount() >= 6);
    assert.equal(proxy.getLastBlockedError()?.code, 'INVALID_URL');
  } finally {
    await proxy.close();
    await new Promise((resolve) => loopbackServer.close(resolve));
  }

  await assertPortClosed(proxy.port);

  // 6. Defense-in-depth CONNECT peer IP check rejects socket reporting private remoteAddress
  const badPeerProxy = await createPinnedSsrfProxy({
    pinnedHosts: new Map([['peer.example.test', [{ address: '93.184.216.34', family: 4 }]]]),
    connect: () => {
      const sock = createFakeDuplexSocket({ remoteAddress: '127.0.0.1' });
      process.nextTick(() => sock.emit('connect'));
      return sock;
    },
  });

  try {
    const res = await sendConnectThroughProxy({
      port: badPeerProxy.port,
      authHeader: getProxyAuthHeader(badPeerProxy.proxyUrl),
      authority: 'peer.example.test:443',
    });
    assert.equal(res.statusCode, 403);
    assert.equal(badPeerProxy.getLastBlockedError()?.code, 'INVALID_URL');
  } finally {
    await badPeerProxy.close();
  }
});

test('buildInspectArgs and inspectMediaUrl route yt-dlp through pinned SSRF proxy and clean up', async () => {
  const withoutProxy = buildInspectArgs({
    playlistMode: false,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  assert.ok(!withoutProxy.includes('--proxy'));

  const withProxy = buildInspectArgs({
    playlistMode: false,
    proxyUrl: 'http://mv:tok@127.0.0.1:43210',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  const proxyIdx = withProxy.indexOf('--proxy');
  assert.ok(proxyIdx !== -1);
  assert.equal(withProxy[proxyIdx + 1], 'http://mv:tok@127.0.0.1:43210');
  assert.equal(withProxy[proxyIdx + 2], '--geo-verification-proxy');
  assert.equal(withProxy[proxyIdx + 3], 'http://mv:tok@127.0.0.1:43210');
  assert.ok(proxyIdx < withProxy.indexOf('--'));

  assert.equal(
    redactProxyCredentials('HTTP Error via http://mv:secret123@127.0.0.1:54321 failed'),
    'HTTP Error via http://127.0.0.1:<ssrf-proxy> failed'
  );

  let lookupCalls = 0;
  let capturedProxyPort = 0;
  let capturedProxyUrl = '';
  let capturedEnv = null;

  const inspectResult = await inspectMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    lookup: async () => {
      lookupCalls += 1;
      return lookupCalls === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    },
    spawnImpl: async (args, opts) => {
      const idx = args.indexOf('--proxy');
      assert.ok(idx !== -1);
      capturedProxyUrl = args[idx + 1];
      capturedProxyPort = Number(new URL(capturedProxyUrl).port);
      capturedEnv = opts.env;
      assert.equal(capturedEnv.HTTP_PROXY, capturedProxyUrl);
      assert.equal(capturedEnv.HTTPS_PROXY, capturedProxyUrl);
      assert.equal(capturedEnv.ALL_PROXY, capturedProxyUrl);
      assert.equal(capturedEnv.NO_PROXY, '');
      return { stdout: JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'Pinned Inspect' }), stderr: '' };
    },
  });

  assert.equal(lookupCalls, 1);
  assert.equal(inspectResult.rawData.title, 'Pinned Inspect');
  await assertPortClosed(capturedProxyPort);

  // Blocked target hit through the proxy during spawn converts to 400 INVALID_URL and closes proxy
  let blockedPort = 0;
  await assert.rejects(
    () =>
      inspectMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        spawnImpl: async (args) => {
          const proxyUrl = args[args.indexOf('--proxy') + 1];
          const parsed = new URL(proxyUrl);
          blockedPort = Number(parsed.port);
          const blockedRes = await sendHttpThroughProxy({
            port: blockedPort,
            authHeader: getProxyAuthHeader(proxyUrl),
            targetUrl: 'http://127.0.0.1:1/secret',
          });
          assert.equal(blockedRes.statusCode, 403);
          throw new Error(`Unable to download via ${proxyUrl}`);
        },
      }),
    { statusCode: 400, code: 'INVALID_URL' }
  );
  await assertPortClosed(blockedPort);
});

test('buildYtDlpJobArgs and worker processJob route downloads through pinned SSRF proxy without MKV fallback on block', async () => {
  const argsWithProxy = buildYtDlpJobArgs({
    url: 'https://www.youtube.com/watch?v=abc',
    mode: 'video',
    container: 'mp4',
    formatSelector: '137+140',
    outputTemplate: '/tmp/job1.%(ext)s',
    proxyUrl: 'http://mv:tok@127.0.0.1:45555',
  });
  assert.equal(argsWithProxy[0], '--js-runtimes');
  assert.equal(argsWithProxy[1], 'node');
  const pIdx = argsWithProxy.indexOf('--proxy');
  assert.ok(pIdx !== -1);
  assert.equal(argsWithProxy[pIdx + 1], 'http://mv:tok@127.0.0.1:45555');
  assert.equal(argsWithProxy[pIdx + 2], '--geo-verification-proxy');
  assert.equal(argsWithProxy[pIdx + 3], 'http://mv:tok@127.0.0.1:45555');
  assert.ok(pIdx < argsWithProxy.indexOf('--'));

  const tempDownloadsDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'mv-worker-ssrf-test-')
  );
  const prevDownloadsDir = process.env.DOWNLOADS_DIR;
  process.env.DOWNLOADS_DIR = tempDownloadsDir;

  const { processJob } = require('../src/worker');

  const origFindById = Job.findById;
  const origFindByIdAndUpdate = Job.findByIdAndUpdate;
  const origFindOneAndUpdate = Job.findOneAndUpdate;
  const origStatfs = fs.promises.statfs;
  const origSetCache = mediaQueue.setJobProgressCache;
  const origClearCache = mediaQueue.clearJobProgressCache;

  const loopbackServer = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('should-never-hit');
  });
  await new Promise((resolve) => loopbackServer.listen(0, '127.0.0.1', resolve));
  const loopbackPort = loopbackServer.address().port;

  try {
    const jobId = '65b2d8e9f1a23c0012a48888';
    const jobDoc = {
      _id: { toString: () => jobId },
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      mode: 'video',
      container: 'mp4',
      formatSelector: '137+140',
      useCookies: false,
      status: 'queued',
      progress: 0,
      title: 'Test Video',
      batchId: null,
    };

    const statusUpdates = [];
    Job.findById = () =>
      Object.assign(Promise.resolve(jobDoc), {
        select: () => ({
          lean: async () => ({ status: jobDoc.status }),
        }),
      });
    Job.findByIdAndUpdate = async (_id, update) => {
      statusUpdates.push(update);
      if (update && update.status) jobDoc.status = update.status;
      return jobDoc;
    };
    Job.findOneAndUpdate = async (filter, update) => {
      const allowed = filter?.status?.$in;
      if (Array.isArray(allowed) && !allowed.includes(jobDoc.status)) {
        return null;
      }
      statusUpdates.push(update);
      if (update && update.status) jobDoc.status = update.status;
      return jobDoc;
    };
    fs.promises.statfs = async () => ({ bavail: 1000000, bsize: 4096 * 1024 });
    mediaQueue.setJobProgressCache = async () => {};
    mediaQueue.clearJobProgressCache = async () => {};

    let downloadCalls = 0;
    let proxyPortSeen = 0;
    let lookupCalls = 0;

    await assert.rejects(
      () =>
        processJob(
          { data: { jobId } },
          {
            lookup: async () => {
              lookupCalls += 1;
              return [{ address: '93.184.216.34', family: 4 }];
            },
            runYtDlpDownload: async ({ args, env }) => {
              downloadCalls += 1;
              const proxyUrl = args[args.indexOf('--proxy') + 1];
              proxyPortSeen = Number(new URL(proxyUrl).port);
              assert.equal(env.HTTP_PROXY, proxyUrl);
              assert.equal(env.HTTPS_PROXY, proxyUrl);
              assert.equal(env.ALL_PROXY, proxyUrl);
              assert.equal(env.NO_PROXY, '');

              const blockedRes = await sendHttpThroughProxy({
                port: proxyPortSeen,
                authHeader: getProxyAuthHeader(proxyUrl),
                targetUrl: `http://127.0.0.1:${loopbackPort}/secret`,
              });
              assert.equal(blockedRes.statusCode, 403);
              throw new Error('mux failed with HTTP Error 403');
            },
          }
        ),
      { statusCode: 400, code: 'INVALID_URL' }
    );

    assert.equal(lookupCalls, 1);
    assert.equal(downloadCalls, 1);
    assert.ok(proxyPortSeen > 0);
    await assertPortClosed(proxyPortSeen);
    const failedUpdate = statusUpdates.find((u) => u.status === 'failed');
    assert.ok(failedUpdate, 'Expected job to be marked failed');
    assert.match(failedUpdate.errorMessage, /restricted IP address/i);
  } finally {
    if (prevDownloadsDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = prevDownloadsDir;
    Job.findById = origFindById;
    Job.findByIdAndUpdate = origFindByIdAndUpdate;
    Job.findOneAndUpdate = origFindOneAndUpdate;
    fs.promises.statfs = origStatfs;
    mediaQueue.setJobProgressCache = origSetCache;
    mediaQueue.clearJobProgressCache = origClearCache;
    await new Promise((resolve) => loopbackServer.close(resolve));
    await fs.promises.rm(tempDownloadsDir, { recursive: true, force: true });
  }
});

test('real yt-dlp binary cannot reach loopback, IMDS, or post-validation redirect targets when routed via createPinnedSsrfProxy', async (t) => {
  const probe = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    t.skip('yt-dlp binary is not installed on host');
    return;
  }

  let loopbackHits = 0;
  const loopbackServer = http.createServer((_req, res) => {
    loopbackHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LOCAL_BYPASS');
  });
  await new Promise((resolve) => loopbackServer.listen(0, '127.0.0.1', resolve));
  const loopbackPort = loopbackServer.address().port;

  const transport = createMockTransport((opts) => {
    if (opts.hostname === 'redirect-to-local.example.test') {
      return {
        statusCode: 302,
        headers: { location: `http://127.0.0.1:${loopbackPort}/secret` },
        socketRemoteAddress: '93.184.216.34',
      };
    }
    return {
      statusCode: 404,
      socketRemoteAddress: '93.184.216.34',
      body: 'not found',
    };
  });

  const proxy = await createPinnedSsrfProxy({
    lookup: async (host) => {
      if (host === 'imds.example.test') {
        return [{ address: '169.254.169.254', family: 4 }];
      }
      if (host === 'redirect-to-local.example.test') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      return [{ address: '127.0.0.1', family: 4 }];
    },
    transport,
  });

  const childEnv = buildProxyChildEnv(proxy.proxyUrl);

  try {
    // 1. Direct loopback URL passed to real yt-dlp
    await assert.rejects(() =>
      spawnYtDlp(
        buildInspectArgs({
          playlistMode: false,
          proxyUrl: proxy.proxyUrl,
          url: `http://127.0.0.1:${loopbackPort}/secret`,
        }),
        { timeoutMs: 15000, env: childEnv }
      )
    );
    assert.ok(proxy.getBlockedCount() >= 1);

    // 2. HTTPS hostname resolving to IMDS passed to real yt-dlp
    const countBeforeImds = proxy.getBlockedCount();
    await assert.rejects(() =>
      spawnYtDlp(
        buildInspectArgs({
          playlistMode: false,
          proxyUrl: proxy.proxyUrl,
          url: 'https://imds.example.test/video',
        }),
        { timeoutMs: 15000, env: childEnv }
      )
    );
    assert.ok(proxy.getBlockedCount() > countBeforeImds);

    // 3. Public URL returning 302 redirect to loopback passed to real yt-dlp
    const countBeforeRedirect = proxy.getBlockedCount();
    await assert.rejects(() =>
      spawnYtDlp(
        buildInspectArgs({
          playlistMode: false,
          proxyUrl: proxy.proxyUrl,
          url: 'http://redirect-to-local.example.test/start',
        }),
        { timeoutMs: 15000, env: childEnv }
      )
    );
    assert.ok(proxy.getBlockedCount() > countBeforeRedirect);
    assert.equal(loopbackHits, 0);
  } finally {
    await proxy.close();
    await new Promise((resolve) => loopbackServer.close(resolve));
  }
});

function invokeRouteStack(router, method, routePath, reqOverrides = {}) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${routePath} route handler`);

  const req = {
    params: {},
    query: {},
    headers: {},
    is: () => false,
    ...reqOverrides,
  };

  return new Promise((resolve) => {
    let settled = false;
    const res = {
      statusCode: 200,
      status(code) {
        res.statusCode = code;
        return res;
      },
      json(payload) {
        if (!settled) {
          settled = true;
          resolve({ statusCode: res.statusCode, payload, error: null });
        }
        return res;
      },
    };

    const handlers = layer.route.stack.map((entry) => entry.handle);
    let idx = 0;

    function dispatch(err) {
      if (settled) return;
      if (err) {
        settled = true;
        resolve({ statusCode: res.statusCode, payload: null, error: err });
        return;
      }
      const fn = handlers[idx++];
      if (!fn) {
        settled = true;
        resolve({ statusCode: res.statusCode, payload: null, error: null });
        return;
      }
      Promise.resolve(fn(req, res, dispatch)).catch((caught) => {
        if (!settled) {
          settled = true;
          resolve({ statusCode: res.statusCode, payload: null, error: caught });
        }
      });
    }

    dispatch();
  });
}

test('requireAdmin rejects missing or non-admin users with 403 and allows admin', () => {
  for (const req of [{}, { user: { id: 'u1', role: 'user' } }]) {
    let capturedErr = null;
    requireAdmin(req, {}, (err) => {
      capturedErr = err;
    });
    assert.equal(capturedErr.statusCode, 403);
    assert.equal(capturedErr.code, 'FORBIDDEN');
  }

  let adminErr;
  requireAdmin({ user: { id: 'a1', role: 'admin' } }, {}, (err) => {
    adminErr = err;
  });
  assert.equal(adminErr, undefined);
});

test('cookie mutation routes enforce requireAdmin while GET /api/cookies remains readable for authenticated users', async () => {
  const prevCookiesDir = process.env.COOKIES_DIR;
  const tempCookiesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-cookies-authz-'));
  process.env.COOKIES_DIR = tempCookiesDir;

  const origFind = Cookie.find;
  const origFindOneAndUpdate = Cookie.findOneAndUpdate;
  const origDeleteOne = Cookie.deleteOne;

  let upsertCalls = 0;
  let deleteCalls = 0;

  Cookie.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });
  Cookie.findOneAndUpdate = async (filter, update) => {
    upsertCalls += 1;
    return { ...filter, ...update };
  };
  Cookie.deleteOne = async () => {
    deleteCalls += 1;
    return { deletedCount: 1 };
  };

  const validNetscape =
    '# Netscape HTTP Cookie File\n' +
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsample-token\n';
  const regularUser = { id: '65b2d8e9f1a23c0012a40001', email: 'user@mediavault.local', role: 'user' };
  const adminUser = { id: '65b2d8e9f1a23c0012a45bc8', email: 'admin@mediavault.local', role: 'admin' };

  try {
    // Authenticated non-admin can list cookie slot status metadata
    const listRes = await invokeRouteStack(cookiesRouter, 'get', '/', { user: regularUser });
    assert.equal(listRes.error, null);
    assert.equal(listRes.statusCode, 200);
    assert.ok(Array.isArray(listRes.payload.cookies));

    // Non-admin cannot upload/replace cookies
    const postDenied = await invokeRouteStack(cookiesRouter, 'post', '/:platform', {
      user: regularUser,
      params: { platform: 'youtube' },
      headers: { 'content-type': 'application/json' },
      body: { cookieText: validNetscape },
    });
    assert.equal(postDenied.error.statusCode, 403);
    assert.equal(postDenied.error.code, 'FORBIDDEN');
    assert.equal(upsertCalls, 0);
    assert.equal(fs.existsSync(path.join(tempCookiesDir, 'youtube.txt')), false);

    // Non-admin cannot delete cookies (seed file first as admin)
    const postAdmin = await invokeRouteStack(cookiesRouter, 'post', '/:platform', {
      user: adminUser,
      params: { platform: 'youtube' },
      headers: { 'content-type': 'application/json' },
      body: { cookieText: validNetscape },
    });
    assert.equal(postAdmin.error, null);
    assert.equal(postAdmin.statusCode, 200);
    assert.equal(upsertCalls, 1);
    assert.equal(fs.existsSync(path.join(tempCookiesDir, 'youtube.txt')), true);

    const deleteDenied = await invokeRouteStack(cookiesRouter, 'delete', '/:platform', {
      user: regularUser,
      params: { platform: 'youtube' },
    });
    assert.equal(deleteDenied.error.statusCode, 403);
    assert.equal(deleteDenied.error.code, 'FORBIDDEN');
    assert.equal(deleteCalls, 0);
    assert.equal(fs.existsSync(path.join(tempCookiesDir, 'youtube.txt')), true);

    // Admin can delete cookies
    const deleteAdmin = await invokeRouteStack(cookiesRouter, 'delete', '/:platform', {
      user: adminUser,
      params: { platform: 'youtube' },
    });
    assert.equal(deleteAdmin.error, null);
    assert.equal(deleteAdmin.statusCode, 200);
    assert.equal(deleteCalls, 1);
    assert.equal(fs.existsSync(path.join(tempCookiesDir, 'youtube.txt')), false);
  } finally {
    Cookie.find = origFind;
    Cookie.findOneAndUpdate = origFindOneAndUpdate;
    Cookie.deleteOne = origDeleteOne;
    if (prevCookiesDir === undefined) delete process.env.COOKIES_DIR;
    else process.env.COOKIES_DIR = prevCookiesDir;
    await fs.promises.rm(tempCookiesDir, { recursive: true, force: true });
  }
});

test('remote tunnel routes under /api/system/remote require admin role', async () => {
  const origGetStatus = remoteTunnel.getStatus;
  const origStart = remoteTunnel.start;
  const origStop = remoteTunnel.stop;

  let getStatusCalls = 0;
  let startCalls = 0;
  let stopCalls = 0;

  remoteTunnel.getStatus = () => {
    getStatusCalls += 1;
    return { status: 'offline', url: null };
  };
  remoteTunnel.start = async () => {
    startCalls += 1;
    return { status: 'online', url: 'https://admin-only.trycloudflare.com' };
  };
  remoteTunnel.stop = async () => {
    stopCalls += 1;
    return { status: 'offline', url: null };
  };

  const regularUser = { id: '65b2d8e9f1a23c0012a40001', email: 'user@mediavault.local', role: 'user' };
  const adminUser = { id: '65b2d8e9f1a23c0012a45bc8', email: 'admin@mediavault.local', role: 'admin' };

  try {
    for (const method of ['get', 'post', 'delete']) {
      const denied = await invokeRouteStack(systemRouter, method, '/remote', { user: regularUser });
      assert.equal(denied.error.statusCode, 403);
      assert.equal(denied.error.code, 'FORBIDDEN');
    }
    assert.equal(getStatusCalls, 0);
    assert.equal(startCalls, 0);
    assert.equal(stopCalls, 0);

    const getRes = await invokeRouteStack(systemRouter, 'get', '/remote', { user: adminUser });
    assert.equal(getRes.error, null);
    assert.equal(getRes.statusCode, 200);
    assert.deepEqual(getRes.payload, { tunnel: { status: 'offline', url: null } });

    const postRes = await invokeRouteStack(systemRouter, 'post', '/remote', { user: adminUser });
    assert.equal(postRes.error, null);
    assert.equal(postRes.statusCode, 200);
    assert.deepEqual(postRes.payload, {
      tunnel: { status: 'online', url: 'https://admin-only.trycloudflare.com' },
    });

    const delRes = await invokeRouteStack(systemRouter, 'delete', '/remote', { user: adminUser });
    assert.equal(delRes.error, null);
    assert.equal(delRes.statusCode, 200);
    assert.deepEqual(delRes.payload, { tunnel: { status: 'offline', url: null } });

    assert.equal(getStatusCalls, 1);
    assert.equal(startCalls, 1);
    assert.equal(stopCalls, 1);
  } finally {
    remoteTunnel.getStatus = origGetStatus;
    remoteTunnel.start = origStart;
    remoteTunnel.stop = origStop;
  }
});
