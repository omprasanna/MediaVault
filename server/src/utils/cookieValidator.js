const { AppError } = require('./errors');

const MAX_COOKIE_BYTES = 512 * 1024;
const HEADER_REGEX = /^#\s*(Netscape\s+)?HTTP Cookie File\b/i;

/**
 * Validates and normalizes Netscape-formatted `cookies.txt` content.
 *
 * @param {string} rawInput
 * @returns {{ normalizedContent: string, cookieCount: number }}
 */
function validateNetscapeCookies(rawInput) {
  if (typeof rawInput !== 'string') {
    throw new AppError(400, 'INVALID_COOKIE_FORMAT', 'Cookie payload must be text.');
  }

  if (Buffer.byteLength(rawInput, 'utf8') > MAX_COOKIE_BYTES) {
    throw new AppError(
      400,
      'INVALID_COOKIE_FORMAT',
      'Cookie file exceeds the 512 KB maximum size.'
    );
  }

  if (rawInput.includes('\0')) {
    throw new AppError(
      400,
      'INVALID_COOKIE_FORMAT',
      'Cookie file contains invalid null bytes.'
    );
  }

  const normalizedNewlines = rawInput
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = normalizedNewlines.split('\n');
  const firstNonEmptyIdx = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIdx === -1 || !HEADER_REGEX.test(lines[firstNonEmptyIdx].trim())) {
    throw new AppError(
      400,
      'INVALID_COOKIE_FORMAT',
      'Invalid Netscape cookie file: missing "# Netscape HTTP Cookie File" header.'
    );
  }

  const outputLines = ['# Netscape HTTP Cookie File'];
  let cookieCount = 0;

  for (let i = firstNonEmptyIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const isHttpOnly = trimmed.startsWith('#HttpOnly_');
    if (trimmed.startsWith('#') && !isHttpOnly) {
      outputLines.push(trimmed);
      continue;
    }

    const parts = line.split('\t');
    if (parts.length !== 7) {
      throw new AppError(
        400,
        'INVALID_COOKIE_FORMAT',
        `Malformed Netscape cookie line ${i + 1}: expected 7 tab-separated columns.`
      );
    }

    const rawDomain = isHttpOnly ? parts[0].slice('#HttpOnly_'.length) : parts[0];
    const domain = rawDomain.trim();
    const includeSubdomains = parts[1].trim();
    const cookiePath = parts[2].trim();
    const secureFlag = parts[3].trim();
    const expiration = parts[4].trim();
    const name = parts[5].trim();

    if (!domain || /\s/.test(domain)) {
      throw new AppError(
        400,
        'INVALID_COOKIE_FORMAT',
        `Invalid domain on cookie line ${i + 1}.`
      );
    }
    if (!/^(TRUE|FALSE)$/i.test(includeSubdomains)) {
      throw new AppError(
        400,
        'INVALID_COOKIE_FORMAT',
        `Invalid domain flag on cookie line ${i + 1}.`
      );
    }
    if (!cookiePath.startsWith('/') || /\s/.test(cookiePath)) {
      throw new AppError(
        400,
        'INVALID_COOKIE_FORMAT',
        `Invalid cookie path on cookie line ${i + 1}.`
      );
    }
    if (!/^(TRUE|FALSE)$/i.test(secureFlag)) {
      throw new AppError(
        400,
        'INVALID_COOKIE_FORMAT',
        `Invalid secure flag on cookie line ${i + 1}.`
      );
    }
    if (!/^\d+$/.test(expiration)) {
      throw new AppError(
        400,
        'INVALID_COOKIE_FORMAT',
        `Invalid expiration timestamp on cookie line ${i + 1}.`
      );
    }
    if (!name || /\s/.test(name)) {
      throw new AppError(
        400,
        'INVALID_COOKIE_FORMAT',
        `Invalid cookie name on cookie line ${i + 1}.`
      );
    }

    cookieCount += 1;
    outputLines.push(
      [
        parts[0].trim(),
        includeSubdomains.toUpperCase(),
        cookiePath,
        secureFlag.toUpperCase(),
        expiration,
        name,
        parts[6],
      ].join('\t')
    );
  }

  if (cookieCount === 0) {
    throw new AppError(
      400,
      'INVALID_COOKIE_FORMAT',
      'Cookie file must contain at least one valid cookie entry.'
    );
  }

  return {
    normalizedContent: `${outputLines.join('\n')}\n`,
    cookieCount,
  };
}

module.exports = {
  MAX_COOKIE_BYTES,
  validateNetscapeCookies,
};
