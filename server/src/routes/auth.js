const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const {
  getAuthCookieOptions,
  getJwtSecret,
  requireAuth,
} = require('../middleware/auth');
const User = require('../models/User');
const { AppError } = require('../utils/errors');

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isDuplicateKeyError(err) {
  return Boolean(err && (err.code === 11000 || err.errorResponse?.code === 11000));
}

function isAdminRoleDuplicateError(err) {
  if (!isDuplicateKeyError(err)) {
    return false;
  }

  const keyPattern = err.keyPattern || err.errorResponse?.keyPattern;
  if (keyPattern && Object.prototype.hasOwnProperty.call(keyPattern, 'role')) {
    return true;
  }

  const keyValue = err.keyValue || err.errorResponse?.keyValue;
  if (keyValue && keyValue.role === 'admin') {
    return true;
  }

  const message = String(err.message || '');
  return message.includes('unique_admin_role') || /dup key:\s*\{\s*role:/i.test(message);
}

function serializeUser(user) {
  return {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
  };
}

/**
 * POST /api/auth/register
 * Registers a new user when `ALLOW_REGISTRATION=true` (returns 403 otherwise).
 */
router.post('/register', async (req, res, next) => {
  try {
    if (String(process.env.ALLOW_REGISTRATION || '').toLowerCase() !== 'true') {
      throw new AppError(
        403,
        'REGISTRATION_DISABLED',
        'Registration is currently disabled on this server.'
      );
    }

    const rawEmail = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';

    if (!rawEmail || !EMAIL_REGEX.test(rawEmail)) {
      throw new AppError(400, 'INVALID_REQUEST', 'A valid email address is required.');
    }

    if (password.length < 8) {
      throw new AppError(
        400,
        'INVALID_REQUEST',
        'Password must be at least 8 characters long.'
      );
    }

    const existing = await User.findOne({ email: rawEmail }).select('_id').lean();
    if (existing) {
      throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const hasExistingUsers = Boolean(await User.exists({}));
    const initialRole = hasExistingUsers ? 'user' : 'admin';

    let user;
    try {
      user = await User.create({
        email: rawEmail,
        passwordHash,
        role: initialRole,
      });
    } catch (createErr) {
      if (initialRole === 'admin' && isAdminRoleDuplicateError(createErr)) {
        try {
          user = await User.create({
            email: rawEmail,
            passwordHash,
            role: 'user',
          });
        } catch (retryErr) {
          if (isDuplicateKeyError(retryErr)) {
            throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
          }
          throw retryErr;
        }
      } else if (isDuplicateKeyError(createErr)) {
        throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
      } else {
        throw createErr;
      }
    }

    return res.status(201).json({
      success: true,
      message: 'User registered successfully.',
      user: serializeUser(user),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/auth/login
 * Authenticates credentials and sets an HTTP-only SameSite=Lax JWT cookie.
 */
router.post('/login', async (req, res, next) => {
  try {
    const rawEmail = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';

    if (!rawEmail || !password) {
      throw new AppError(400, 'INVALID_REQUEST', 'Email and password are required.');
    }

    const user = await User.findOne({ email: rawEmail });
    if (!user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password.');
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password.');
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = jwt.sign(
      {
        sub: user._id.toString(),
        email: user.email,
        role: user.role,
      },
      getJwtSecret(),
      {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      }
    );

    res.cookie('jwt', token, getAuthCookieOptions());

    return res.status(200).json({
      success: true,
      user: serializeUser(user),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/auth/logout
 * Clears the HTTP-only JWT authentication cookie.
 */
router.post('/logout', requireAuth, (_req, res) => {
  const { maxAge: _ignored, ...clearOptions } = getAuthCookieOptions();
  res.clearCookie('jwt', clearOptions);
  return res.status(200).json({
    success: true,
    message: 'Logged out successfully.',
  });
});

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile.
 */
router.get('/me', requireAuth, (req, res) => {
  return res.status(200).json({
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
    },
  });
});

module.exports = router;
