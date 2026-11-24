const express = require('express');
const { AppError } = require('../utils/errors');
const { inspectMediaUrl } = require('../utils/ytdlp');
const { mapInspectResponse, sanitizeFilename } = require('../utils/formatMapper');
const { registerDirectStream } = require('../utils/proxyStore');

const router = express.Router();

/**
 * POST /api/inspect
 * Inspects a supported media or playlist URL via yt-dlp without queuing a download.
 */
router.post('/', async (req, res, next) => {
  try {
    const rawUrl = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
    if (!rawUrl) {
      throw new AppError(400, 'INVALID_URL', 'Request body must include a valid "url" string.');
    }

    const useCookies = req.body.useCookies === true;
    const includePlaylist = req.body.includePlaylist === true;
    const { platform, url, rawData } = await inspectMediaUrl(rawUrl, {
      useCookies,
      includePlaylist,
    });
    const mapped = mapInspectResponse(rawData, { platform, sourceUrl: url });

    if (!mapped.isPlaylist && Array.isArray(mapped.formats)) {
      mapped.formats = mapped.formats.map((fmt) => {
        const { _httpHeaders, ...publicFormat } = fmt;
        if (publicFormat.delivery === 'direct' && publicFormat.directUrl) {
          const filename = sanitizeFilename(mapped.title, publicFormat.container);
          const token = registerDirectStream({
            url: publicFormat.directUrl,
            headers: _httpHeaders || {},
            filename,
            platform,
          });
          return {
            ...publicFormat,
            proxyUrl: `/api/proxy?token=${token}`,
          };
        }
        return publicFormat;
      });
    }

    return res.status(200).json(mapped);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
