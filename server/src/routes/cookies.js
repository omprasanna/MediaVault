const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const Cookie = require('../models/Cookie');
const { MAX_COOKIE_BYTES, validateNetscapeCookies } = require('../utils/cookieValidator');
const { AppError } = require('../utils/errors');
const { ALLOWED_PLATFORMS } = require('../utils/ytdlp');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_COOKIE_BYTES,
    files: 1,
  },
});

function getCookiesDir() {
  return path.resolve(process.env.COOKIES_DIR || '/data/cookies');
}

function validatePlatformParam(rawPlatform) {
  const platform = String(rawPlatform || '').trim().toLowerCase();
  if (!ALLOWED_PLATFORMS.includes(platform)) {
    throw new AppError(
      400,
      'INVALID_REQUEST',
      `Unsupported platform "${platform}". Allowed: ${ALLOWED_PLATFORMS.join(', ')}.`
    );
  }
  return platform;
}

function handleUploadMiddleware(req, res, next) {
  if (!req.is('multipart/form-data')) {
    return next();
  }
  return upload.any()(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return next(new AppError(400, 'INVALID_COOKIE_FORMAT', err.message));
    }
    if (err) {
      return next(err);
    }
    return next();
  });
}

function extractRawCookieText(req) {
  if (Array.isArray(req.files) && req.files.length > 0 && req.files[0].buffer) {
    return req.files[0].buffer.toString('utf8');
  }
  if (req.body && typeof req.body === 'object' && typeof req.body.cookieText === 'string') {
    return req.body.cookieText;
  }
  if (typeof req.body === 'string') {
    return req.body;
  }
  return '';
}

/**
 * GET /api/cookies
 * Lists cookie installation status for all supported platforms.
 */
router.get('/', async (_req, res, next) => {
  try {
    const cookiesDir = getCookiesDir();
    const docs = await Cookie.find().select('platform isValid updatedAt').lean();
    const docsByPlatform = new Map(docs.map((doc) => [doc.platform, doc]));

    const cookies = await Promise.all(
      ALLOWED_PLATFORMS.map(async (platform) => {
        const filePath = path.join(cookiesDir, `${platform}.txt`);
        let fileStats = null;
        try {
          fileStats = await fs.promises.stat(filePath);
        } catch {
          fileStats = null;
        }

        const doc = docsByPlatform.get(platform);
        const installed = Boolean(fileStats && fileStats.isFile());

        return {
          platform,
          installed,
          isValid: installed ? doc?.isValid !== false : null,
          updatedAt: installed
            ? (doc?.updatedAt || fileStats.mtime).toISOString()
            : null,
        };
      })
    );

    return res.status(200).json({ cookies });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/cookies/:platform
 * Validates Netscape cookie content, saves to `/data/cookies/<platform>.txt` (0600),
 * and upserts the Cookie record in MongoDB.
 */
router.post(
  '/:platform',
  express.text({ type: 'text/plain', limit: '512kb' }),
  handleUploadMiddleware,
  async (req, res, next) => {
    try {
      const platform = validatePlatformParam(req.params.platform);
      const rawContent = extractRawCookieText(req);
      const { normalizedContent, cookieCount } = validateNetscapeCookies(rawContent);

      const cookiesDir = getCookiesDir();
      await fs.promises.mkdir(cookiesDir, { recursive: true });
      const cookiePath = path.join(cookiesDir, `${platform}.txt`);

      await fs.promises.writeFile(cookiePath, normalizedContent, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.promises.chmod(cookiePath, 0o600);

      await Cookie.findOneAndUpdate(
        { platform },
        {
          platform,
          content: normalizedContent,
          isValid: true,
          updatedBy: req.user.id,
        },
        { upsert: true, new: true }
      );

      return res.status(200).json({
        success: true,
        message: `Cookies for ${platform} successfully updated and validated.`,
        platform,
        cookieCount,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * DELETE /api/cookies/:platform
 * Deletes the platform cookie file from disk and clears its MongoDB record.
 */
router.delete('/:platform', async (req, res, next) => {
  try {
    const platform = validatePlatformParam(req.params.platform);
    const cookiePath = path.join(getCookiesDir(), `${platform}.txt`);

    await Cookie.deleteOne({ platform });
    try {
      await fs.promises.unlink(cookiePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    return res.status(200).json({
      success: true,
      message: `Cookies for ${platform} successfully deleted.`,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
