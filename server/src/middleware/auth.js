const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { AppError } = require('../utils/errors');

const DEFAULT_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns the configured JWT signing secret.
 *
 * @returns {string}
 */
function getJwtSecret() {
  return process.env.JWT_SECRET || 'mediavault-dev-secret';
}

/**
 * Converts a duration string (e.g. `7d`, `24h`, `30m`, `60s`) or numeric seconds to milliseconds.
 *
 * @param {string | number} expiresIn
 * @returns {number}
 */
function parseDurationToMs(expiresIn) {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return expiresIn * 1000;
  }

  const raw = String(expiresIn || '').trim();
  if (!raw) {
    return DEFAULT_EXPIRES_MS;
  }

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

  const match = raw.match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    return DEFAULT_EXPIRES_MS;
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}

/**
 * Cookie attributes for the HTTP-only JWT authentication cookie.
 */
function getAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: parseDurationToMs(process.env.JWT_EXPIRES_IN || '7d'),
  };
}

/**
 * Express middleware verifying the HTTP-only `jwt` cookie and attaching `req.user`.
 */
async function requireAuth(req, _res, next) {
  try {
    const token = req.cookies && req.cookies.jwt;
    if (!token || typeof token !== 'string') {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
    }

    let payload;
    try {
      payload = jwt.verify(token, getJwtSecret());
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired authentication token.');
    }

    if (!payload || typeof payload.sub !== 'string') {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid authentication token payload.');
    }

    const user = await User.findById(payload.sub).select('_id email role').lean();
    if (!user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authenticated user no longer exists.');
    }

    req.user = {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Express middleware restricting access to admin users.
 */
function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return next(new AppError(403, 'FORBIDDEN', 'Administrator privileges are required.'));
  }
  return next();
}

module.exports = {
  getJwtSecret,
  parseDurationToMs,
  getAuthCookieOptions,
  requireAuth,
  requireAdmin,
};
