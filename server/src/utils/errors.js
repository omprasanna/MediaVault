/**
 * Structured application error matching MediaVault's standardized JSON envelope.
 */
class AppError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details=null]
   */
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Express centralized error handler producing `{ error: { code, message, details } }`.
 */
function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? null,
      },
    });
  }

  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Malformed JSON request body.',
        details: null,
      },
    });
  }

  if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
    return res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: err.message,
        details: null,
      },
    });
  }

  console.error('Unhandled API error:', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal server error occurred.',
      details: null,
    },
  });
}

module.exports = {
  AppError,
  errorHandler,
};
