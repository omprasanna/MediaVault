const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { AppError } = require('./errors');
const {
  canonicalizeIp,
  isPrivateIp,
  requestResolvedPublicUrl,
  resolvePublicUrl,
  validatePublicUrlSyntax,
} = require('./ssrf');

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'host',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Builds child subprocess environment variables forcing HTTP/HTTPS clients
 * (yt-dlp, curl_cffi, urllib, requests, and ffmpeg) through the ephemeral proxy
 * without bypassing for localhost or inherited NO_PROXY entries.
 *
 * @param {string} proxyUrl
 * @param {NodeJS.ProcessEnv} [baseEnv=process.env]
 * @returns {NodeJS.ProcessEnv}
 */
function buildProxyChildEnv(proxyUrl, baseEnv = process.env) {
  return {
    ...baseEnv,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  };
}

/**
 * Masks ephemeral loopback proxy credentials before logging or surfacing errors.
 *
 * @param {string} text
 * @returns {string}
 */
function redactProxyCredentials(text) {
  return String(text || '').replace(
    /http:\/\/mv:[^@\s'"]+@127\.0\.0\.1:\d+/gi,
    'http://127.0.0.1:<ssrf-proxy>'
  );
}

/**
 * Parses a CONNECT request authority (`host:port` or `[ipv6]:port`).
 *
 * @param {string} authority
 * @returns {{ host: string, port: number } | null}
 */
function parseConnectAuthority(authority) {
  const raw = String(authority || '').trim();
  if (!raw) {
    return null;
  }

  let host;
  let portStr;

  if (raw.startsWith('[')) {
    const closeIdx = raw.indexOf(']');
    if (closeIdx <= 1 || raw[closeIdx + 1] !== ':') {
      return null;
    }
    host = raw.slice(1, closeIdx);
    portStr = raw.slice(closeIdx + 2);
  } else {
    const firstColon = raw.indexOf(':');
    const lastColon = raw.lastIndexOf(':');
    if (firstColon <= 0 || firstColon !== lastColon) {
      return null;
    }
    host = raw.slice(0, firstColon);
    portStr = raw.slice(firstColon + 1);
  }

  if (!/^\d+$/.test(portStr)) {
    return null;
  }

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return {
    host: host.toLowerCase(),
    port,
  };
}

function normalizePinnedHost(rawHost) {
  return String(rawHost || '')
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
}

function normalizeSeededPinnedHosts(pinnedHosts) {
  const pinnedMap = new Map();
  if (!pinnedHosts) {
    return pinnedMap;
  }

  const entries =
    pinnedHosts instanceof Map || typeof pinnedHosts[Symbol.iterator] === 'function'
      ? pinnedHosts
      : Object.entries(pinnedHosts);

  for (const [rawHost, rawAddresses] of entries) {
    const host = normalizePinnedHost(rawHost);
    if (!host || !Array.isArray(rawAddresses) || rawAddresses.length === 0) {
      throw new AppError(400, 'INVALID_URL', 'Pinned SSRF host entries must include addresses.');
    }

    const validated = rawAddresses.map((entry) => {
      const address = typeof entry?.address === 'string' ? entry.address.trim() : '';
      const family = net.isIP(address);
      if (family === 0 || isPrivateIp(address)) {
        throw new AppError(
          400,
          'INVALID_URL',
          'Target host resolves to a restricted IP address.'
        );
      }
      return { address, family };
    });

    pinnedMap.set(host, validated);
  }

  return pinnedMap;
}

/**
 * Starts an ephemeral, loopback-only, Basic-authenticated HTTP/CONNECT proxy that
 * reuses already validated IP addresses (`pinnedHosts`), pins subsequent lookups for
 * the lifetime of the proxy, blocks private/non-public targets and unsafe redirects,
 * and verifies connected socket peer IP addresses before forwarding any traffic.
 *
 * @param {{
 *   pinnedHosts?: Map<string, Array<{ address: string, family?: number }>> | Record<string, Array<{ address: string, family?: number }>>,
 *   lookup?: Function,
 *   connect?: typeof net.connect,
 *   transport?: typeof http,
 *   preferIpv4?: boolean,
 *   connectTimeoutMs?: number,
 * }} [options]
 */
async function createPinnedSsrfProxy(options = {}) {
  const {
    pinnedHosts,
    lookup,
    connect,
    transport,
    preferIpv4 = true,
    connectTimeoutMs = 15000,
  } = options;

  const pinnedMap = normalizeSeededPinnedHosts(pinnedHosts);
  const token = crypto.randomBytes(32).toString('hex');
  const expectedAuthHeader = `Basic ${Buffer.from(`mv:${token}`, 'utf8').toString('base64')}`;
  const expectedAuthBuffer = Buffer.from(expectedAuthHeader, 'utf8');

  let lastBlockedError = null;
  let blockedCount = 0;
  const activeSockets = new Set();

  function trackSocket(socket) {
    if (!socket) return;
    activeSockets.add(socket);
    if (typeof socket.once === 'function') {
      socket.once('close', () => {
        activeSockets.delete(socket);
      });
    }
  }

  function recordBlocked(err) {
    lastBlockedError = err;
    blockedCount += 1;
    return err;
  }

  function isAuthorized(headerValue) {
    if (typeof headerValue !== 'string') {
      return false;
    }
    const providedBuffer = Buffer.from(headerValue, 'utf8');
    if (providedBuffer.length !== expectedAuthBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(providedBuffer, expectedAuthBuffer);
  }

  async function resolveAndPinUrl(rawUrl) {
    try {
      const { url, hostname } = validatePublicUrlSyntax(rawUrl);
      if (pinnedMap.has(hostname)) {
        return {
          url,
          hostname,
          addresses: pinnedMap.get(hostname).map((entry) => ({ ...entry })),
        };
      }

      const resolved = await resolvePublicUrl(rawUrl, { lookup });
      pinnedMap.set(
        resolved.hostname,
        resolved.addresses.map((entry) => ({ ...entry }))
      );
      return resolved;
    } catch (err) {
      if (err instanceof AppError && err.code === 'INVALID_URL') {
        recordBlocked(err);
      }
      throw err;
    }
  }

  async function connectPinnedTcp({ addresses, port }) {
    const allowedCanonicalIps = new Set(
      addresses.map((entry) => canonicalizeIp(entry.address)).filter(Boolean)
    );
    if (allowedCanonicalIps.size === 0) {
      throw recordBlocked(
        new AppError(400, 'INVALID_URL', 'Target host resolves to a restricted IP address.')
      );
    }

    const orderedCandidates = preferIpv4
      ? [
          ...addresses.filter((entry) => entry.family === 4),
          ...addresses.filter((entry) => entry.family !== 4),
        ]
      : [...addresses];

    const connectFn = connect || net.connect;
    let lastNetworkError = null;

    for (const candidate of orderedCandidates) {
      try {
        const socket = await new Promise((resolve, reject) => {
          let settled = false;
          const sock = connectFn({
            host: candidate.address,
            port,
            family: candidate.family,
          });

          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            const timeoutErr = new Error(
              `Timed out connecting to ${candidate.address}:${port}`
            );
            timeoutErr.code = 'ETIMEDOUT';
            sock.removeListener('connect', onConnect);
            sock.removeListener('error', onError);
            sock.on('error', () => {});
            sock.destroy(timeoutErr);
            reject(timeoutErr);
          }, connectTimeoutMs);
          if (typeof timer.unref === 'function') {
            timer.unref();
          }

          const onConnect = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.removeListener('error', onError);

            if (sock.remoteAddress) {
              const canonicalRemote = canonicalizeIp(sock.remoteAddress);
              if (
                !canonicalRemote ||
                isPrivateIp(sock.remoteAddress) ||
                !allowedCanonicalIps.has(canonicalRemote)
              ) {
                const guardErr = recordBlocked(
                  new AppError(
                    400,
                    'INVALID_URL',
                    'Target connection resolved to an unvalidated or restricted IP address.'
                  )
                );
                sock.on('error', () => {});
                sock.destroy(guardErr);
                reject(guardErr);
                return;
              }
            }

            resolve(sock);
          };

          const onError = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.removeListener('connect', onConnect);
            sock.on('error', () => {});
            sock.destroy();
            reject(err);
          };

          sock.once('connect', onConnect);
          sock.once('error', onError);
        });

        return socket;
      } catch (err) {
        if (err instanceof AppError && err.code === 'INVALID_URL') {
          throw err;
        }
        lastNetworkError = err;
      }
    }

    throw lastNetworkError || new Error('Failed to connect to any validated upstream address.');
  }

  const server = http.createServer(async (clientReq, clientRes) => {
    trackSocket(clientReq.socket);

    if (!isAuthorized(clientReq.headers['proxy-authorization'])) {
      clientRes.writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="mediavault-ssrf-proxy"',
        'Content-Type': 'text/plain',
        Connection: 'close',
      });
      clientRes.end('Proxy authentication required.');
      return;
    }

    const targetUrl = String(clientReq.url || '');
    if (!/^https?:\/\//i.test(targetUrl)) {
      recordBlocked(
        new AppError(400, 'INVALID_URL', 'Only absolute HTTP and HTTPS proxy URLs are allowed.')
      );
      clientRes.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
      clientRes.end('Blocked by SSRF guard.');
      return;
    }

    let resolved;
    try {
      resolved = await resolveAndPinUrl(targetUrl);
    } catch (err) {
      if (err instanceof AppError && err.code === 'INVALID_URL') {
        clientRes.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
        clientRes.end('Blocked by SSRF guard.');
        return;
      }
      clientRes.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
      clientRes.end('Bad gateway.');
      return;
    }

    const forwardedHeaders = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase()) && value !== undefined) {
        forwardedHeaders[key] = value;
      }
    }

    const methodUpper = String(clientReq.method || 'GET').toUpperCase();
    const hasBody =
      !['GET', 'HEAD'].includes(methodUpper) &&
      (clientReq.headers['content-length'] !== undefined ||
        clientReq.headers['transfer-encoding'] !== undefined);

    const ac = new AbortController();
    const onAborted = () => ac.abort();
    clientReq.once('aborted', onAborted);

    let upstream = null;
    try {
      upstream = await requestResolvedPublicUrl(resolved, {
        method: methodUpper,
        headers: forwardedHeaders,
        body: hasBody ? clientReq : undefined,
        signal: ac.signal,
        transport,
        preferIpv4,
      });

      if (REDIRECT_STATUS_CODES.has(upstream.status)) {
        const location = upstream.headers.get('location');
        if (location) {
          let nextUrl;
          try {
            nextUrl = new URL(location, resolved.url).toString();
          } catch {
            recordBlocked(
              new AppError(
                400,
                'INVALID_URL',
                'Upstream redirect contained an invalid Location header.'
              )
            );
            upstream.cancel();
            if (!clientRes.headersSent) {
              clientRes.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
              clientRes.end('Blocked by SSRF guard.');
            }
            return;
          }

          try {
            await resolveAndPinUrl(nextUrl);
          } catch (redirectErr) {
            if (redirectErr instanceof AppError && redirectErr.code === 'INVALID_URL') {
              upstream.cancel();
              if (!clientRes.headersSent) {
                clientRes.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
                clientRes.end('Blocked by SSRF guard.');
              }
              return;
            }
            upstream.cancel();
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
              clientRes.end('Bad gateway.');
            }
            return;
          }
        }
      }

      if (clientRes.destroyed || clientReq.destroyed) {
        upstream.cancel();
        return;
      }

      const outHeaders = {};
      for (const [key, value] of upstream.headers.entries()) {
        const lower = key.toLowerCase();
        if (lower === 'set-cookie' || HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) {
          continue;
        }
        outHeaders[key] = value;
      }
      if (typeof upstream.headers.getSetCookie === 'function') {
        const cookies = upstream.headers.getSetCookie();
        if (cookies.length > 0) {
          outHeaders['set-cookie'] = cookies;
        }
      }

      clientRes.writeHead(upstream.status, outHeaders);

      const onClientClose = () => {
        if (!clientRes.writableEnded) {
          upstream.cancel();
        }
      };
      clientRes.once('close', onClientClose);
      clientRes.on('error', () => {
        upstream.cancel();
      });

      upstream.body.on('error', () => {
        if (!clientRes.destroyed) {
          clientRes.destroy();
        }
      });

      upstream.body.pipe(clientRes);
    } catch (err) {
      upstream?.cancel();
      if (err?.name === 'AbortError' || clientRes.destroyed) {
        return;
      }
      if (err instanceof AppError && err.code === 'INVALID_URL') {
        recordBlocked(err);
        if (!clientRes.headersSent) {
          clientRes.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
          clientRes.end('Blocked by SSRF guard.');
        } else {
          clientRes.destroy();
        }
        return;
      }
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
        clientRes.end('Bad gateway.');
      } else {
        clientRes.destroy();
      }
    } finally {
      clientReq.off('aborted', onAborted);
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    trackSocket(clientSocket);

    if (!isAuthorized(req.headers['proxy-authorization'])) {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
          'Proxy-Authenticate: Basic realm="mediavault-ssrf-proxy"\r\n' +
          'Connection: close\r\n\r\n'
      );
      clientSocket.destroy();
      return;
    }

    const authority = parseConnectAuthority(req.url);
    if (!authority) {
      recordBlocked(new AppError(400, 'INVALID_URL', 'Invalid CONNECT target authority.'));
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const formattedHost = net.isIPv6(authority.host)
      ? `[${authority.host}]`
      : authority.host;
    const syntheticUrl = `https://${formattedHost}:${authority.port}/`;

    let resolved;
    try {
      resolved = await resolveAndPinUrl(syntheticUrl);
    } catch (err) {
      const statusLine =
        err instanceof AppError && err.code === 'INVALID_URL'
          ? '403 Forbidden'
          : '502 Bad Gateway';
      if (!clientSocket.destroyed) {
        clientSocket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
        clientSocket.destroy();
      }
      return;
    }

    if (clientSocket.destroyed) {
      return;
    }

    let upstreamSocket;
    try {
      upstreamSocket = await connectPinnedTcp({
        addresses: resolved.addresses,
        port: authority.port,
      });
    } catch (err) {
      const statusLine =
        err instanceof AppError && err.code === 'INVALID_URL'
          ? '403 Forbidden'
          : '502 Bad Gateway';
      if (!clientSocket.destroyed) {
        clientSocket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
        clientSocket.destroy();
      }
      return;
    }

    trackSocket(upstreamSocket);

    if (clientSocket.destroyed) {
      upstreamSocket.destroy();
      return;
    }

    upstreamSocket.on('error', () => {
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    });
    clientSocket.on('error', () => {
      if (!upstreamSocket.destroyed) {
        upstreamSocket.destroy();
      }
    });
    upstreamSocket.once('close', () => {
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    });
    clientSocket.once('close', () => {
      if (!upstreamSocket.destroyed) {
        upstreamSocket.destroy();
      }
    });

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const proxyUrl = `http://mv:${token}@127.0.0.1:${port}`;
  let closed = false;

  return {
    proxyUrl,
    port,
    getLastBlockedError: () => lastBlockedError,
    getBlockedCount: () => blockedCount,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const socket of activeSockets) {
        try {
          socket.destroy();
        } catch {
          // Ignore teardown errors
        }
      }
      activeSockets.clear();
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  buildProxyChildEnv,
  redactProxyCredentials,
  parseConnectAuthority,
  createPinnedSsrfProxy,
};
