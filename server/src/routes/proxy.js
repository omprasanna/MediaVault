const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { AppError } = require('../utils/errors');
const { assertPublicUrl } = require('../utils/ssrf');
const { getByToken, getByUrl } = require('../utils/proxyStore');
const { sanitizeFilename } = require('../utils/formatMapper');

const router = express.Router();

const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const KNOWN_MEDIA_EXTS = new Set(['mp4', 'webm', 'mkv', 'm4a', 'mp3']);

function getRootDomain(hostname) {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname.toLowerCase();
}

function inferExtensionFromContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('audio/mp4') || normalized.includes('m4a')) return 'm4a';
  if (normalized.includes('matroska')) return 'mkv';
  return 'mp4';
}

function buildAttachmentFilename(rawName, contentType) {
  const raw = String(rawName || 'media_file').trim();
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = raw.slice(dotIdx + 1).toLowerCase();
    if (KNOWN_MEDIA_EXTS.has(ext)) {
      return sanitizeFilename(raw.slice(0, dotIdx), ext);
    }
  }
  return sanitizeFilename(raw, inferExtensionFromContentType(contentType));
}

/**
 * Fetches an upstream media URL while manually handling redirects and validating
 * the initial target plus every redirect hop against the SSRF guard.
 */
async function fetchWithSsrfGuard(initialUrl, { method, headers, signal }) {
  let currentUrl = initialUrl;
  let initialRootDomain = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = await assertPublicUrl(currentUrl);
    if (hop === 0) {
      initialRootDomain = getRootDomain(parsed.hostname);
    }

    const hopHeaders = { ...headers };
    if (hop > 0 && getRootDomain(parsed.hostname) !== initialRootDomain) {
      delete hopHeaders.Cookie;
    }

    const upstream = await fetch(parsed.toString(), {
      method,
      headers: hopHeaders,
      redirect: 'manual',
      signal,
    });

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const location = upstream.headers.get('location');
      await upstream.body?.cancel().catch(() => {});
      if (!location) {
        throw new AppError(502, 'PROXY_UPSTREAM_ERROR', 'Upstream redirect missing Location header.');
      }
      currentUrl = new URL(location, parsed).toString();
      continue;
    }

    return upstream;
  }

  throw new AppError(502, 'PROXY_UPSTREAM_ERROR', 'Exceeded maximum upstream redirect hops.');
}

function applyResponseHeaders(res, upstream, rawFilename) {
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const safeName = buildAttachmentFilename(rawFilename, contentType);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store');

  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }

  const contentRange = upstream.headers.get('content-range');
  if (contentRange) {
    res.setHeader('Content-Range', contentRange);
  }

  const acceptRanges = upstream.headers.get('accept-ranges');
  if (acceptRanges) {
    res.setHeader('Accept-Ranges', acceptRanges);
  }
}

/**
 * GET /api/proxy (and HEAD /api/proxy)
 * Directly pipes progressive CDN media bytes to the client without local disk storage.
 */
router.get('/', async (req, res, next) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    const queryUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';

    let targetUrl;
    let baseHeaders = {};
    let defaultFilename = 'media_file';

    if (token) {
      const entry = getByToken(token);
      if (!entry) {
        throw new AppError(
          404,
          'PROXY_TOKEN_EXPIRED',
          'Direct proxy token is invalid or has expired. Please re-inspect the URL.'
        );
      }
      targetUrl = entry.url;
      baseHeaders = { ...entry.headers };
      defaultFilename = entry.filename || 'media_file';
    } else if (queryUrl) {
      targetUrl = queryUrl;
      const cached = getByUrl(queryUrl);
      if (cached) {
        baseHeaders = { ...cached.headers };
        defaultFilename = cached.filename || 'media_file';
      }
    } else {
      throw new AppError(400, 'INVALID_URL', 'Query parameter "token" or "url" is required.');
    }

    if (typeof req.query.userAgent === 'string' && req.query.userAgent.trim()) {
      baseHeaders['User-Agent'] = req.query.userAgent.trim();
    }
    if (typeof req.query.referer === 'string' && req.query.referer.trim()) {
      baseHeaders.Referer = req.query.referer.trim();
    }
    if (typeof req.query.cookie === 'string' && req.query.cookie.trim()) {
      baseHeaders.Cookie = req.query.cookie.trim();
    }
    if (!baseHeaders['User-Agent']) {
      baseHeaders['User-Agent'] = DEFAULT_USER_AGENT;
    }

    const requestedFilename =
      typeof req.query.filename === 'string' && req.query.filename.trim()
        ? req.query.filename.trim()
        : defaultFilename;

    if (req.method === 'HEAD') {
      let upstream = await fetchWithSsrfGuard(targetUrl, {
        method: 'HEAD',
        headers: baseHeaders,
      });

      if ([403, 405, 501].includes(upstream.status)) {
        await upstream.body?.cancel().catch(() => {});
        const probeController = new AbortController();
        upstream = await fetchWithSsrfGuard(targetUrl, {
          method: 'GET',
          headers: baseHeaders,
          signal: probeController.signal,
        });
        const status = upstream.status;
        if (status < 200 || status >= 400) {
          probeController.abort();
          await upstream.body?.cancel().catch(() => {});
          throw new AppError(
            status >= 400 && status < 500 ? status : 502,
            'PROXY_UPSTREAM_ERROR',
            `Upstream media CDN returned HTTP ${status}.`
          );
        }
        applyResponseHeaders(res, upstream, requestedFilename);
        probeController.abort();
        await upstream.body?.cancel().catch(() => {});
        return res.status(status).end();
      }

      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        throw new AppError(
          upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
          'PROXY_UPSTREAM_ERROR',
          `Upstream media CDN returned HTTP ${upstream.status}.`
        );
      }

      applyResponseHeaders(res, upstream, requestedFilename);
      await upstream.body?.cancel().catch(() => {});
      return res.status(upstream.status).end();
    }

    if (req.headers.range) {
      baseHeaders.Range = req.headers.range;
    }

    const controller = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    res.on('close', onClientClose);

    try {
      const upstream = await fetchWithSsrfGuard(targetUrl, {
        method: 'GET',
        headers: baseHeaders,
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel().catch(() => {});
        throw new AppError(
          upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
          'PROXY_UPSTREAM_ERROR',
          `Upstream media CDN returned HTTP ${upstream.status}.`
        );
      }

      applyResponseHeaders(res, upstream, requestedFilename);
      res.status(upstream.status);

      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (streamErr) {
      if (
        controller.signal.aborted ||
        streamErr?.name === 'AbortError' ||
        streamErr?.code === 'ERR_STREAM_PREMATURE_CLOSE'
      ) {
        return;
      }
      throw streamErr;
    } finally {
      res.off('close', onClientClose);
    }
  } catch (err) {
    if (!res.headersSent) {
      return next(err);
    }
    res.destroy(err);
  }
});

module.exports = router;
