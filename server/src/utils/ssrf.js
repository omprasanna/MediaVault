const dns = require('dns');
const net = require('net');
const { AppError } = require('./errors');

const RESTRICTED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

/**
 * Checks whether an IPv4 address belongs to a private, loopback, link-local,
 * carrier-grade NAT, multicast, or reserved subnet.
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

  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
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
 * Checks whether an IPv4 or IPv6 address is private, loopback, link-local, or reserved.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (typeof ip !== 'string' || !ip.trim()) {
    return true;
  }

  const cleanIp = ip.trim().replace(/^\[(.*)\]$/, '$1').split('%')[0];
  const ipVersion = net.isIP(cleanIp);

  if (ipVersion === 4) {
    return isPrivateIpv4(cleanIp);
  }

  if (ipVersion === 6) {
    const groups = expandIpv6(cleanIp);
    if (!groups) {
      return true;
    }

    const allZeroPrefix = groups.slice(0, 6).every((g) => g === 0);
    // Unspecified (::) or loopback (::1)
    if (allZeroPrefix && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) {
      return true;
    }

    // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96)
    const isIpv4Mapped =
      groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    if (isIpv4Mapped || allZeroPrefix) {
      const embeddedIpv4 = [
        (groups[6] >> 8) & 0xff,
        groups[6] & 0xff,
        (groups[7] >> 8) & 0xff,
        groups[7] & 0xff,
      ].join('.');
      return isPrivateIpv4(embeddedIpv4);
    }

    // Unique local addresses (fc00::/7)
    if ((groups[0] & 0xfe00) === 0xfc00) {
      return true;
    }

    // Link-local unicast (fe80::/10)
    if ((groups[0] & 0xffc0) === 0xfe80) {
      return true;
    }

    // Multicast (ff00::/8)
    if ((groups[0] & 0xff00) === 0xff00) {
      return true;
    }

    return false;
  }

  return true;
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

  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (
    !hostname ||
    RESTRICTED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new AppError(400, 'INVALID_URL', 'Target host resolves to a restricted address.');
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateIp(hostname)) {
      throw new AppError(
        400,
        'INVALID_URL',
        'Target host resolves to a restricted IP address.'
      );
    }
    return parsed;
  }

  const lookupFn = options.lookup || dns.promises.lookup;
  let records;
  try {
    records = await lookupFn(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError(400, 'INVALID_URL', 'Unable to resolve target hostname.');
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new AppError(400, 'INVALID_URL', 'Unable to resolve target hostname.');
  }

  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new AppError(
        400,
        'INVALID_URL',
        'Target host resolves to a restricted IP address.'
      );
    }
  }

  return parsed;
}

module.exports = {
  isPrivateIp,
  assertPublicUrl,
};
