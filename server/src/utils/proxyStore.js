const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;

const byToken = new Map();
const byUrl = new Map();

function deleteEntry(entry) {
  if (!entry) return;
  byToken.delete(entry.token);
  const currentByUrl = byUrl.get(entry.url);
  if (currentByUrl && currentByUrl.token === entry.token) {
    byUrl.delete(entry.url);
  }
}

function pruneExpired(now = Date.now()) {
  for (const entry of byToken.values()) {
    if (entry.expiresAt <= now) {
      deleteEntry(entry);
    }
  }
}

function sanitizeStoredHeaders(headers) {
  const clean = {};
  if (!headers || typeof headers !== 'object') {
    return clean;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value.length > 0) {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Registers a direct CDN media stream URL and its yt-dlp upstream HTTP headers
 * in a bounded 30-minute in-memory TTL store.
 *
 * @param {{ url: string, headers?: Record<string, string>, filename?: string, platform?: string }} params
 * @returns {string} Opaque proxy lookup token
 */
function registerDirectStream({ url, headers = {}, filename = 'media_file', platform = 'unknown' }) {
  const now = Date.now();
  pruneExpired(now);

  // Replace existing entry for the same URL to prevent stale token bloat.
  const existing = byUrl.get(url);
  if (existing) {
    deleteEntry(existing);
  }

  while (byToken.size >= MAX_ENTRIES) {
    const oldest = byToken.values().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }

  const token = crypto.randomBytes(16).toString('hex');
  const entry = {
    token,
    url,
    headers: sanitizeStoredHeaders(headers),
    filename,
    platform,
    expiresAt: now + TTL_MS,
  };

  byToken.set(token, entry);
  byUrl.set(url, entry);
  return token;
}

/**
 * Retrieves a cached direct stream entry by opaque token if still valid.
 *
 * @param {string} token
 */
function getByToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const entry = byToken.get(token);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    deleteEntry(entry);
    return null;
  }
  return entry;
}

/**
 * Retrieves cached yt-dlp HTTP headers by exact upstream CDN URL if still valid.
 *
 * @param {string} url
 */
function getByUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const entry = byUrl.get(url);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    deleteEntry(entry);
    return null;
  }
  return entry;
}

module.exports = {
  registerDirectStream,
  getByToken,
  getByUrl,
};
