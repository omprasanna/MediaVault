const { spawn } = require('child_process');
const path = require('path');

const VALID_ROLES = new Set(['all', 'api', 'worker', 'client']);
const ROLE = String(process.env.APP_ROLE || 'all').trim().toLowerCase();
const API_PORT = String(process.env.API_PORT || '5000');
const WEB_PORT = String(process.env.PORT || '3000');
const INTERNAL_API_URL = (
  process.env.INTERNAL_API_URL || `http://127.0.0.1:${API_PORT}`
).replace(/\/+$/, '');

if (!VALID_ROLES.has(ROLE)) {
  console.error(
    `Invalid APP_ROLE="${ROLE}". Expected one of: all, api, worker, client.`
  );
  process.exit(1);
}

const activeChildren = new Map();
let shuttingDown = false;
let shutdownPromise = null;

function spawnRoleProcess(name, scriptPath, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'production',
      ...extraEnv,
    },
    stdio: 'inherit',
  });

  const entry = {
    name,
    child,
    exited: false,
    code: null,
    signal: null,
  };
  activeChildren.set(name, entry);

  child.on('error', (err) => {
    entry.exited = true;
    console.error(`[entrypoint] Failed to start ${name}: ${err.message}`);
    if (!shuttingDown) {
      void shutdown(1, `${name} spawn error`);
    }
  });

  child.on('exit', (code, signal) => {
    entry.exited = true;
    entry.code = code;
    entry.signal = signal;
    activeChildren.delete(name);

    if (!shuttingDown) {
      const reason = signal
        ? `${name} terminated with signal ${signal}`
        : `${name} exited with code ${code}`;
      console.error(`[entrypoint] Unexpected process exit: ${reason}`);
      void shutdown(typeof code === 'number' && code !== 0 ? code : 1, reason);
    }
  });

  return entry;
}

async function waitForApiHealth(apiEntry, timeoutMs = 45000) {
  const healthUrl = `http://127.0.0.1:${API_PORT}/api/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (shuttingDown || apiEntry.exited) {
      return false;
    }

    try {
      const res = await fetch(healthUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        return true;
      }
    } catch {
      // Wait for Express API listener to come up
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function shutdown(exitCode = 0, reason = 'signal') {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  console.log(`[entrypoint] Shutting down (${reason})...`);

  shutdownPromise = (async () => {
    const entries = Array.from(activeChildren.values());
    if (entries.length === 0) {
      process.exit(exitCode);
    }

    const waitPromises = entries.map(
      ({ child, exited }) =>
        new Promise((resolve) => {
          if (exited || child.killed) {
            resolve();
            return;
          }
          child.once('close', () => resolve());
          child.kill('SIGTERM');
        })
    );

    const forceTimer = setTimeout(() => {
      for (const { child, exited } of entries) {
        if (!exited) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore already-dead process
          }
        }
      }
    }, 10000);
    forceTimer.unref();

    await Promise.allSettled(waitPromises);
    clearTimeout(forceTimer);
    process.exit(exitCode);
  })();

  return shutdownPromise;
}

function startApi() {
  return spawnRoleProcess(
    'api',
    path.join('/app/server/src', 'api.js'),
    '/app/server',
    { PORT: API_PORT }
  );
}

function startWorker() {
  return spawnRoleProcess(
    'worker',
    path.join('/app/server/src', 'worker.js'),
    '/app/server'
  );
}

function startClient() {
  return spawnRoleProcess(
    'client',
    path.join('/app/client', 'server.js'),
    '/app/client',
    {
      PORT: WEB_PORT,
      HOSTNAME: '0.0.0.0',
      INTERNAL_API_URL,
      NEXT_TELEMETRY_DISABLED: '1',
    }
  );
}

process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => void shutdown(0, 'SIGINT'));

(async () => {
  console.log(`[entrypoint] Starting MediaVault (APP_ROLE=${ROLE})`);

  if (ROLE === 'api') {
    startApi();
    return;
  }

  if (ROLE === 'worker') {
    startWorker();
    return;
  }

  if (ROLE === 'client') {
    startClient();
    return;
  }

  const apiEntry = startApi();
  const ready = await waitForApiHealth(apiEntry);
  if (!ready) {
    if (!shuttingDown) {
      console.error('[entrypoint] API server did not become healthy in time.');
      await shutdown(1, 'api startup failure');
    }
    return;
  }

  if (shuttingDown) {
    return;
  }

  startWorker();
  startClient();
})();
