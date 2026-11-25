const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRemoteTunnelManager } = require('../src/utils/remoteTunnel');

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    child.emit('exit', null, signal);
    return true;
  };
  return child;
}

test('remote tunnel starts once, returns its Quick Tunnel URL, and stops cleanly', async () => {
  const child = createFakeChild();
  const calls = [];
  const manager = createRemoteTunnelManager({
    binaryPath: 'cloudflared-test',
    origin: 'http://127.0.0.1:3000',
    spawnProcess: (...args) => {
      calls.push(args);
      return child;
    },
  });

  const firstStart = manager.start();
  const secondStart = manager.start();
  child.stderr.write('Quick Tunnel ready: https://sample-remote.trycloudflare.com\n');

  assert.deepEqual(await firstStart, {
    status: 'online',
    url: 'https://sample-remote.trycloudflare.com',
  });
  assert.deepEqual(await secondStart, {
    status: 'online',
    url: 'https://sample-remote.trycloudflare.com',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'cloudflared-test');
  assert.deepEqual(calls[0][1], [
    'tunnel',
    '--no-autoupdate',
    '--url',
    'http://127.0.0.1:3000',
  ]);

  assert.deepEqual(await manager.stop(), { status: 'offline', url: null });
  assert.equal(child.signalCode, 'SIGTERM');
});

test('remote tunnel reports startup failure and clears its state', async () => {
  const child = createFakeChild();
  const manager = createRemoteTunnelManager({
    spawnProcess: () => child,
    startupTimeoutMs: 100,
  });

  const startup = manager.start();
  child.emit('exit', 1, null);

  await assert.rejects(startup, {
    code: 'REMOTE_TUNNEL_UNAVAILABLE',
    message: 'Cloudflare Tunnel exited before becoming ready (code 1).',
  });
  assert.deepEqual(manager.getStatus(), { status: 'offline', url: null });
});
