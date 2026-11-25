const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { AppError } = require('../utils/errors');

const DEFAULT_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_JWT_SECRET_LENGTH = 32;
const MIN_JWT_SECRET_UNIQUE_CHARS = 6;
const JWT_SECRET_HELP =
  'Generate a cryptographically secure secret (e.g. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` or `openssl rand -hex 32`).';

const KNOWN_WEAK_JWT_SECRETS = new Set([
  'mediavault-dev-secret',
  'replace-with-a-strong-random-secret',
  'changeme',
  'change-me',
  'change_me',
  'secret',
  'jwt-secret',
  'jwt_secret',
  'default',
  'default-secret',
  'dev-secret',
  'development',
  'test-secret',
  'password',
  'example-secret',
  'your-secret-here',
  'your-jwt-secret',
  'replace-me',
  'replace_me',
  'placeholder',
  'supersecret',
  'mysecret',
]);

const PLACEHOLDER_SECRET_PATTERNS = [
  /mediavault[-_ ]?dev[-_ ]?secret/i,
  /replace[-_ ]?with/i,
  /change[-_ ]?me/i,
  /your[-_ ]?(jwt[-_ ]?)?secret/i,
];

/**
 * Validates that JWT_SECRET is configured, non-placeholder, and sufficiently strong.
 *
 * @param {string | undefined} [rawSecret]
 * @returns {string}
 */
function validateJwtSecret(rawSecret = process.env.JWT_SECRET) {
  if (typeof rawSecret !== 'string' || rawSecret.trim().length === 0) {
    throw new Error(
      `JWT_SECRET environment variable is required and cannot be empty. ${JWT_SECRET_HELP}`
    );
  }

  const secret = rawSecret.trim();
  const normalized = secret.toLowerCase();

  if (
    KNOWN_WEAK_JWT_SECRETS.has(normalized) ||
    PLACEHOLDER_SECRET_PATTERNS.some((pattern) => pattern.test(secret))
  ) {
    throw new Error(
      `JWT_SECRET must not use a known fallback or placeholder value. ${JWT_SECRET_HELP}`
    );
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long. ${JWT_SECRET_HELP}`
    );
  }

  if (new Set(secret).size < MIN_JWT_SECRET_UNIQUE_CHARS) {
    throw new Error(
      `JWT_SECRET has insufficient character diversity and appears weak. ${JWT_SECRET_HELP}`
    );
  }

  return secret;
}

/**
 * Returns the validated JWT signing secret.
 *
 * @returns {string}
 */
function getJwtSecret() {
  return validateJwtSecret(process.env.JWT_SECRET);
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

    const jwtSecret = getJwtSecret();

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
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
  validateJwtSecret,
  parseDurationToMs,
  getAuthCookieOptions,
  requireAuth,
  requireAdmin,
};
