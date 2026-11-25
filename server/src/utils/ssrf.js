const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { AppError } = require('./errors');

const RESTRICTED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

function normalizeHostname(rawHostname) {
  return String(rawHostname || '')
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
}

function createAbortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

/**
 * Checks whether an IPv4 address belongs to a private, loopback, link-local,
 * carrier-grade NAT, documentation, benchmarking, multicast, or reserved subnet.
 *
 * @param {string} ipv4
 * @returns {boolean}
 */
function isPrivateIpv4(ipv4) {
  const parts = ipv4.split('.');
  if (parts.length !== 4) {
    return true;
  }

  const octets = parts.map((part) => Number(part));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true;
  }

  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 Relay Anycast)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast

  return false;
}

/**
 * Expands a valid IPv6 address (without zone suffix) into 8 16-bit integer groups.
 *
 * @param {string} raw
 * @returns {number[] | null}
 */
function expandIpv6(raw) {
  let addr = raw.toLowerCase();

  // Convert trailing embedded IPv4 (e.g., ::ffff:127.0.0.1) to two hex groups.
  const lastColon = addr.lastIndexOf(':');
  const tail = lastColon >= 0 ? addr.slice(lastColon + 1) : '';
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) {
      return null;
    }
    const octets = tail.split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  if (halves.length === 1 && left.length !== 8) {
    return null;
  }

  const missing = 8 - (left.length + right.length);
  if (halves.length === 2 && missing < 0) {
    return null;
  }

  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...right,
  ];

  if (groups.length !== 8) {
    return null;
  }

  const parsed = groups.map((g) => parseInt(g, 16));
  if (parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) {
    return null;
  }

  return parsed;
}

/**
 * Normalizes an IPv4 or IPv6 address into a canonical string for exact equality comparison.
 * IPv4-mapped IPv6 addresses (`::ffff:0:0/96`) normalize to their IPv4 form.
 *
 * @param {string} ip
 * @returns {string | null}
 */
function canonicalizeIp(ip) {
  if (typeof ip !== 'string') {
    return null;
  }

  const clean = ip.trim().replace(/^\[(.*)\]$/, '$1');
  if (!clean || clean.includes('%')) {
    return null;
  }

  const ipVersion = net.isIP(clean);
  if (ipVersion === 4) {
    return clean
      .split('.')
      .map((part) => String(Number(part)))
      .join('.');
  }

  if (ipVersion === 6) {
    const groups = expandIpv6(clean);
    if (!groups) {
      return null;
    }

    const isIpv4Mapped =
      groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    if (isIpv4Mapped) {
      return [
        (groups[6] >> 8) & 0xff,
        groups[6] & 0xff,
        (groups[7] >> 8) & 0xff,
        groups[7] & 0xff,
      ].join('.');
    }

    return groups.map((g) => g.toString(16).padStart(4, '0')).join(':');
  }

  return null;
}

/**
 * Checks whether an IPv4 or IPv6 address is private, loopback, link-local, or reserved.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (typeof ip !== 'string' || !ip.trim()) {
    return true;
  }

  const cleanIp = ip.trim().replace(/^\[(.*)\]$/, '$1');
  if (cleanIp.includes('%')) {
    return true; // Zone identifiers are link/interface-local and never public.
  }

  const ipVersion = net.isIP(cleanIp);

  if (ipVersion === 4) {
    return isPrivateIpv4(cleanIp);
  }

  if (ipVersion === 6) {
    const groups = expandIpv6(cleanIp);
    if (!groups) {
      return true;
    }

    // IPv4-mapped IPv6 (::ffff:0:0/96)
    const isIpv4Mapped =
      groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    if (isIpv4Mapped) {
      const embeddedIpv4 = [
        (groups[6] >> 8) & 0xff,
        groups[6] & 0xff,
        (groups[7] >> 8) & 0xff,
        groups[7] & 0xff,
      ].join('.');
      return isPrivateIpv4(embeddedIpv4);
    }

    // Only Global Unicast (2000::/3) may be routed publicly.
    // Blocks ::, ::1, ::/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64,
    // fc00::/7, fe80::/10, fec0::/10, ff00::/8, and all unassigned prefixes.
    if ((groups[0] & 0xe000) !== 0x2000) {
      return true;
    }

    // Teredo (2001::/32)
    if (groups[0] === 0x2001 && groups[1] === 0x0000) {
      return true;
    }

    // Benchmarking (2001:2::/48)
    if (groups[0] === 0x2001 && groups[1] === 0x0002 && groups[2] === 0x0000) {
      return true;
    }

    // ORCHID (2001:10::/28) and ORCHIDv2 (2001:20::/28)
    if (
      groups[0] === 0x2001 &&
      ((groups[1] & 0xfff0) === 0x0010 || (groups[1] & 0xfff0) === 0x0020)
    ) {
      return true;
    }

    // Documentation (2001:db8::/32)
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) {
      return true;
    }

    // 6to4 (2002::/16)
    if (groups[0] === 0x2002) {
      return true;
    }

    // Documentation (3fff::/20, RFC 9637)
    if (groups[0] === 0x3fff && (groups[1] & 0xf000) === 0x0000) {
      return true;
    }

    return false;
  }

  return true;
}

/**
 * Validates URL syntax, HTTP(S) scheme, absence of credentials, and non-restricted hostnames.
 *
 * @param {string} rawUrl
 * @returns {{ url: URL, hostname: string }}
 */
function validatePublicUrlSyntax(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'The provided URL is not valid.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(400, 'INVALID_URL', 'Only HTTP and HTTPS URLs are allowed.');
  }

  if (parsed.username || parsed.password) {
    throw new AppError(400, 'INVALID_URL', 'URLs containing credentials are not allowed.');
  }

  const hostname = normalizeHostname(parsed.hostname);
  const normalizedHost = hostname.replace(/\.+$/, '');
  if (
    !normalizedHost ||
    RESTRICTED_HOSTNAMES.has(normalizedHost) ||
    normalizedHost.endsWith('.localhost') ||
    normalizedHost.endsWith('.local') ||
    normalizedHost.endsWith('.internal')
  ) {
    throw new AppError(400, 'INVALID_URL', 'Target host resolves to a restricted address.');
  }

  return {
    url: parsed,
    hostname,
  };
}

const TRANSIENT_DNS_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'EAI_FAIL',
  'ETIMEOUT',
  'ETIMEDOUT',
  'ESERVFAIL',
  'EREFUSED',
]);

/**
 * Resolves DNS records for `hostname`, falling back to c-ares resolve4/resolve6
 * and IPv4-only lookup on transient musl/Docker DNS failures (e.g. slow AAAA causing
 * EAI_AGAIN). Custom `options.lookup` overrides rethrow unless `options.allowFallback`
 * is explicitly set.
 *
 * @param {string} hostname
 * @param {{
 *   lookup?: typeof dns.promises.lookup,
 *   resolve4?: typeof dns.promises.resolve4,
 *   resolve6?: typeof dns.promises.resolve6,
 *   allowFallback?: boolean,
 * }} [options]
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
async function resolveHostRecords(hostname, options = {}) {
  const lookupFn = options.lookup || dns.promises.lookup;
  try {
    return await lookupFn(hostname, { all: true, verbatim: true });
  } catch (err) {
    if (options.lookup && !options.allowFallback) {
      throw err;
    }

    const code = err && typeof err.code === 'string' ? err.code : '';
    if (!TRANSIENT_DNS_ERROR_CODES.has(code)) {
      throw err;
    }

    const resolve4Fn = options.resolve4 || dns.promises.resolve4;
    const resolve6Fn = options.resolve6 || dns.promises.resolve6;
    const [v4Result, v6Result] = await Promise.allSettled([
      resolve4Fn(hostname),
      resolve6Fn(hostname),
    ]);

    const combined = [];
    if (v4Result.status === 'fulfilled' && Array.isArray(v4Result.value)) {
      for (const ip of v4Result.value) {
        if (typeof ip === 'string' && ip.trim()) {
          combined.push({ address: ip.trim(), family: 4 });
        }
      }
    }
    if (v6Result.status === 'fulfilled' && Array.isArray(v6Result.value)) {
      for (const ip of v6Result.value) {
        if (typeof ip === 'string' && ip.trim()) {
          combined.push({ address: ip.trim(), family: 6 });
        }
      }
    }

    if (combined.length > 0) {
      return combined;
    }

    return lookupFn(hostname, { family: 4, all: true, verbatim: true });
  }
}

/**
 * Validates that a URL uses HTTP(S), has no embedded credentials, resolves via DNS
 * (once), and returns the parsed URL along with validated public IP records.
 *
 * @param {string} rawUrl
 * @param {{
 *   lookup?: typeof dns.promises.lookup,
 *   resolve4?: typeof dns.promises.resolve4,
 *   resolve6?: typeof dns.promises.resolve6,
 *   allowFallback?: boolean,
 * }} [options]
 * @returns {Promise<{ url: URL, hostname: string, addresses: Array<{ address: string, family: number }> }>}
 */
async function resolvePublicUrl(rawUrl, options = {}) {
  const { url: parsed, hostname } = validatePublicUrlSyntax(rawUrl);

  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    if (isPrivateIp(hostname)) {
      throw new AppError(
        400,
        'INVALID_URL',
        'Target host resolves to a restricted IP address.'
      );
    }
    return {
      url: parsed,
      hostname,
      addresses: [{ address: hostname, family: literalFamily }],
    };
  }

  let records;
  try {
    records = await resolveHostRecords(hostname, options);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'Unable to resolve target hostname.');
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new AppError(400, 'INVALID_URL', 'Unable to resolve target hostname.');
  }

  const seenCanonical = new Set();
  const addresses = [];

  for (const record of records) {
    const address = typeof record?.address === 'string' ? record.address.trim() : '';
    const family = net.isIP(address);
    if (family === 0 || isPrivateIp(address)) {
      throw new AppError(
        400,
        'INVALID_URL',
        'Target host resolves to a restricted IP address.'
      );
    }
    const canonical = canonicalizeIp(address);
    if (!canonical) {
      throw new AppError(
        400,
        'INVALID_URL',
        'Target host resolves to a restricted IP address.'
      );
    }
    if (!seenCanonical.has(canonical)) {
      seenCanonical.add(canonical);
      addresses.push({ address, family });
    }
  }

  return {
    url: parsed,
    hostname,
    addresses,
  };
}

/**
 * Validates that a URL uses HTTP(S), has no embedded credentials, and resolves
 * solely to non-private public IP addresses.
 *
 * @param {string} rawUrl
 * @param {{ lookup?: typeof dns.promises.lookup }} [options]
 * @returns {Promise<URL>}
 */
async function assertPublicUrl(rawUrl, options = {}) {
  const resolved = await resolvePublicUrl(rawUrl, options);
  return resolved.url;
}

function orderAddresses(addresses, preferIpv4) {
  if (!preferIpv4 || addresses.length <= 1) {
    return addresses;
  }
  const v4 = addresses.filter((entry) => entry.family === 4);
  const v6 = addresses.filter((entry) => entry.family !== 4);
  return [...v4, ...v6];
}

/**
 * Creates a `net.connect` / `http.request` compatible `lookup` callback pinned to
 * the exact public addresses returned during initial validation, preventing a second
 * unrestricted DNS resolution (DNS rebinding).
 *
 * @param {string} expectedHostname
 * @param {Array<{ address: string, family?: number }>} validatedAddresses
 * @param {{ preferIpv4?: boolean }} [options]
 * @returns {(hostname: string, options: unknown, callback?: Function) => void}
 */
function createPinnedLookup(expectedHostname, validatedAddresses, options = {}) {
  const targetHost = normalizeHostname(expectedHostname);
  if (!targetHost || !Array.isArray(validatedAddresses) || validatedAddresses.length === 0) {
    throw new AppError(400, 'INVALID_URL', 'Unable to pin DNS lookup without validated addresses.');
  }

  const normalizedEntries = orderAddresses(
    validatedAddresses.map((entry) => {
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
    }),
    options.preferIpv4 === true
  );

  return function pinnedLookup(hostname, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    } else if (typeof opts === 'number') {
      opts = { family: opts };
    } else if (!opts || typeof opts !== 'object') {
      opts = {};
    }

    if (normalizeHostname(hostname) !== targetHost) {
      process.nextTick(() => {
        cb(
          new AppError(
            400,
            'INVALID_URL',
            'Unexpected hostname encountered during pinned DNS lookup.'
          )
        );
      });
      return;
    }

    let requestedFamily = 0;
    if (opts.family === 4 || opts.family === 'IPv4') {
      requestedFamily = 4;
    } else if (opts.family === 6 || opts.family === 'IPv6') {
      requestedFamily = 6;
    }

    const matches = requestedFamily
      ? normalizedEntries.filter((entry) => entry.family === requestedFamily)
      : normalizedEntries;

    if (matches.length === 0) {
      const notFoundErr = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      notFoundErr.code = 'ENOTFOUND';
      notFoundErr.errno = 'ENOTFOUND';
      notFoundErr.hostname = hostname;
      process.nextTick(() => cb(notFoundErr));
      return;
    }

    if (opts.all) {
      process.nextTick(() =>
        cb(
          null,
          matches.map((entry) => ({ address: entry.address, family: entry.family }))
        )
      );
      return;
    }

    process.nextTick(() => cb(null, matches[0].address, matches[0].family));
  };
}

function toWebHeaders(rawHeaders) {
  if (rawHeaders instanceof Headers) {
    return new Headers(rawHeaders);
  }
  const headers = new Headers();
  if (!rawHeaders || typeof rawHeaders !== 'object') {
    return headers;
  }
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          headers.append(key, String(item));
        }
      }
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

/**
 * Executes an HTTP(S) request against a previously validated public target by pinning
 * socket DNS resolution (`lookup` + `agent: false`) and verifying the connected peer IP.
 *
 * @param {{ url: URL, hostname: string, addresses: Array<{ address: string, family: number }> }} resolved
 * @param {{ method?: string, headers?: Record<string, string>, signal?: AbortSignal, transport?: typeof http }} [options]
 */
function requestResolvedPublicUrl(resolved, options = {}) {
  if (
    !resolved ||
    !(resolved.url instanceof URL) ||
    !resolved.hostname ||
    !Array.isArray(resolved.addresses) ||
    resolved.addresses.length === 0
  ) {
    return Promise.reject(new AppError(400, 'INVALID_URL', 'The provided URL is not valid.'));
  }

  const {
    method = 'GET',
    headers = {},
    body,
    signal,
    transport,
    preferIpv4 = false,
  } = options;

  if (signal && signal.aborted) {
    return Promise.reject(createAbortError());
  }

  let pinnedLookup;
  try {
    pinnedLookup = createPinnedLookup(resolved.hostname, resolved.addresses, { preferIpv4 });
  } catch (err) {
    return Promise.reject(err);
  }

  const allowedCanonicalIps = new Set(
    resolved.addresses.map((entry) => canonicalizeIp(entry.address)).filter(Boolean)
  );
  if (allowedCanonicalIps.size === 0) {
    return Promise.reject(
      new AppError(400, 'INVALID_URL', 'Target host resolves to a restricted IP address.')
    );
  }

  const sanitizedHeaders = {};
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== 'host' && value !== undefined) {
        sanitizedHeaders[key] = value;
      }
    }
  }

  const isHttps = resolved.url.protocol === 'https:';
  const httpModule = transport || (isHttps ? https : http);
  const port = resolved.url.port ? Number(resolved.url.port) : isHttps ? 443 : 80;
  const requestPath = `${resolved.url.pathname}${resolved.url.search}` || '/';

  const requestOptions = {
    protocol: resolved.url.protocol,
    hostname: resolved.hostname,
    port,
    path: requestPath,
    method,
    headers: sanitizedHeaders,
    agent: false,
    lookup: pinnedLookup,
    signal,
    ...(isHttps && net.isIP(resolved.hostname) === 0 ? { servername: resolved.hostname } : {}),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeResponse = null;
    let req = null;

    const rejectOnce = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };

    const verifySocketAddress = (socket) => {
      if (!socket || !socket.remoteAddress) {
        return true;
      }

      const canonicalRemote = canonicalizeIp(socket.remoteAddress);
      if (
        !canonicalRemote ||
        isPrivateIp(socket.remoteAddress) ||
        !allowedCanonicalIps.has(canonicalRemote)
      ) {
        const err = new AppError(
          400,
          'INVALID_URL',
          'Target connection resolved to an unvalidated or restricted IP address.'
        );
        socket.destroy(err);
        if (req && !req.destroyed) {
          req.destroy(err);
        }
        rejectOnce(err);
        return false;
      }

      return true;
    };

    req = httpModule.request(requestOptions, (res) => {
      if (settled) {
        res.on('error', () => {});
        if (!res.destroyed) {
          res.destroy();
        }
        return;
      }

      if (res.socket && !verifySocketAddress(res.socket)) {
        res.on('error', () => {});
        if (!res.destroyed) {
          res.destroy();
        }
        return;
      }

      activeResponse = res;
      let cancelled = false;
      const cancel = () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        res.on('error', () => {});
        if (!res.destroyed) {
          res.destroy();
        }
        if (req && !req.destroyed) {
          req.destroy();
        }
      };

      settled = true;
      resolve({
        status: res.statusCode || 0,
        ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
        headers: toWebHeaders(res.headers),
        body: res,
        cancel,
        url: resolved.url,
        resolvedAddresses: resolved.addresses.map((entry) => ({ ...entry })),
      });
    });

    req.on('socket', (socket) => {
      if (!verifySocketAddress(socket)) {
        return;
      }
      if (typeof socket.once === 'function') {
        socket.once('connect', () => {
          verifySocketAddress(socket);
        });
        socket.once('secureConnect', () => {
          verifySocketAddress(socket);
        });
      }
    });

    req.on('error', (err) => {
      if (!settled) {
        rejectOnce(err);
      } else if (activeResponse && !activeResponse.destroyed) {
        activeResponse.destroy(err);
      }
    });

    if (body && typeof body.pipe === 'function') {
      body.on('error', (err) => {
        if (!settled) {
          rejectOnce(err);
        }
        if (req && !req.destroyed) {
          req.destroy(err);
        }
      });
      body.pipe(req);
    } else if (body !== undefined && body !== null) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

/**
 * Resolves, validates, and sends an HTTP(S) request using the exact validated address.
 *
 * @param {string} rawUrl
 * @param {{ method?: string, headers?: Record<string, string>, signal?: AbortSignal, lookup?: typeof dns.promises.lookup, transport?: typeof http, preferIpv4?: boolean }} [options]
 */
async function requestPublicUrl(rawUrl, options = {}) {
  const resolved = await resolvePublicUrl(rawUrl, { lookup: options.lookup });
  return requestResolvedPublicUrl(resolved, options);
}

module.exports = {
  isPrivateIp,
  canonicalizeIp,
  validatePublicUrlSyntax,
  resolvePublicUrl,
  assertPublicUrl,
  createPinnedLookup,
  requestResolvedPublicUrl,
  requestPublicUrl,
};
