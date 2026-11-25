const { spawn } = require('child_process');

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const STARTUP_TIMEOUT_MS = 45000;

function createRemoteTunnelManager({
  spawnProcess = spawn,
  binaryPath = process.env.CLOUDFLARED_PATH || 'cloudflared',
  origin = process.env.REMOTE_TUNNEL_ORIGIN || 'http://127.0.0.1:3000',
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
} = {}) {
  let activeTunnel = null;
  let startPromise = null;

  function getStatus() {
    return {
      status: activeTunnel ? (activeTunnel.url ? 'online' : 'starting') : 'offline',
      url: activeTunnel?.url || null,
    };
  }

  function start() {
    if (activeTunnel?.url) {
      return Promise.resolve(getStatus());
    }
    if (startPromise) {
      return startPromise;
    }

    startPromise = new Promise((resolve, reject) => {
      const child = spawnProcess(
        binaryPath,
        ['tunnel', '--no-autoupdate', '--url', origin],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const tunnel = { child, url: null };
      activeTunnel = tunnel;
      let output = '';
      let settled = false;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (activeTunnel === tunnel) activeTunnel = null;
        child.kill('SIGTERM');
        const error = new Error(message);
        error.code = 'REMOTE_TUNNEL_UNAVAILABLE';
        reject(error);
      };

      const readOutput = (chunk) => {
        output = `${output}${chunk.toString()}`.slice(-8192);
        const match = output.match(TUNNEL_URL_PATTERN);
        if (match && !settled) {
          settled = true;
          tunnel.url = match[0];
          clearTimeout(timeout);
          resolve(getStatus());
        }
      };

      const timeout = setTimeout(() => {
        fail('Cloudflare Tunnel did not provide a URL before the startup timeout.');
      }, startupTimeoutMs);
      timeout.unref?.();

      child.stdout?.on('data', readOutput);
      child.stderr?.on('data', readOutput);
      child.once('error', () => {
        fail('Unable to start Cloudflare Tunnel. Confirm cloudflared is installed.');
      });
      child.once('exit', (code) => {
        if (activeTunnel === tunnel) activeTunnel = null;
        if (!settled) {
          fail(`Cloudflare Tunnel exited before becoming ready (code ${code ?? 'unknown'}).`);
        }
      });
    }).finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  async function stop() {
    const tunnel = activeTunnel;
    activeTunnel = null;
    if (!tunnel) return getStatus();
    await new Promise((resolve) => {
      if (tunnel.child.exitCode != null || tunnel.child.signalCode != null) {
        resolve();
        return;
      }

      const forceTimer = setTimeout(() => {
        tunnel.child.kill('SIGKILL');
        resolve();
      }, 3000);
      tunnel.child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });
      tunnel.child.kill('SIGTERM');
    });
    return getStatus();
  }

  return { getStatus, start, stop };
}

const remoteTunnel = createRemoteTunnelManager();

module.exports = { createRemoteTunnelManager, remoteTunnel };
