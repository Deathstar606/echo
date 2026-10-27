const multer = require('multer');
const AppError = require('../utils/AppError');
const env = require('../config/env');

function notFoundHandler(req, res, next) {
  next(
    new AppError(
      `Route not found: ${req.method} ${req.originalUrl}`,
      404
    )
  );
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Handle Multer-specific file upload errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = (env.maxUploadSizeBytes / (1024 * 1024)).toFixed(2);
      return res.status(400).json({
        error: `Uploaded file exceeds the maximum allowed size of ${maxMb} MB.`,
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error:
          'Unexpected file field. Upload a single CSV file using the form-data field name "file" or "customer_csv".',
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Only one CSV file can be uploaded per request.',
      });
    }
    return res.status(400).json({
      error: `File upload error: ${err.message}`,
    });
  }

  // Handle malformed JSON request bodies from express.json()
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Malformed JSON in request body.',
    });
  }

  // Handle intentional operational errors
  if (err instanceof AppError || err.isOperational) {
    const payload = {
      error: err.message,
    };
    if (err.details !== undefined) {
      payload.details = err.details;
    }
    return res.status(err.statusCode || 400).json(payload);
  }

  // Handle PostgreSQL-specific errors cleanly
  if (err && typeof err.code === 'string') {
    if (err.code === '22P02') {
      return res.status(400).json({
        error: 'Invalid data format or UUID provided.',
      });
    }
    if (err.code === '23503') {
      if (err.constraint === 'fk_conversations_customer_business') {
        return res.status(400).json({
          error: 'Customer does not belong to the specified business.',
        });
      }
      return res.status(404).json({
        error: 'Referenced resource does not exist.',
      });
    }
    if (err.code === '23514') {
      return res.status(400).json({
        error: 'Invalid field value violates database constraint.',
      });
    }
    if (err.code === '42P01') {
      return res.status(500).json({
        error:
          'Database tables are not initialized. Please run "npm run db:init" first.',
      });
    }
    if (
      err.code === 'ECONNREFUSED' ||
      err.code === 'ENOTFOUND' ||
      err.code === 'ETIMEDOUT' ||
      err.code === '28P01' ||
      err.code === '3D000'
    ) {
      console.error('Database connection error:', err.message);
      return res.status(503).json({
        error:
          'Database connection failed. Verify that PostgreSQL is running and DATABASE_URL is configured properly.',
      });
    }
  }

  console.error('Unhandled error:', err);

  return res.status(500).json({
    error: 'Internal server error.',
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
