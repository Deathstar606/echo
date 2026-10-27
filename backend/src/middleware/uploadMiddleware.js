const path = require('node:path');
const multer = require('multer');
const env = require('../config/env');
const AppError = require('../utils/AppError');

const ALLOWED_CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'text/x-csv',
  'application/x-csv',
  'text/comma-separated-values',
  'text/x-comma-separated-values',
  'application/octet-stream',
]);

function csvFileFilter(req, file, cb) {
  const originalName = file.originalname || '';
  const ext = path.extname(originalName).toLowerCase();
  const mimeType = (file.mimetype || '').toLowerCase();

  if (ext !== '.csv') {
    return cb(
      new AppError(
        'Invalid file type. Only .csv files are accepted.',
        400
      )
    );
  }

  if (mimeType && !ALLOWED_CSV_MIME_TYPES.has(mimeType)) {
    return cb(
      new AppError(
        `Invalid file MIME type "${file.mimetype}". Only CSV files are accepted.`,
        400
      )
    );
  }

  return cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.maxUploadSizeBytes,
    files: 5,
  },
  fileFilter: csvFileFilter,
});

/**
 * Middleware that accepts a single CSV file from multipart/form-data.
 * Supports standard field name "file", alternative field names like "customer_csv" or "csv",
 * and handles cases where a client might include both or use a custom field name.
 */
function uploadSingleCsv(req, res, next) {
  upload.any()(req, res, (err) => {
    if (err) {
      return next(err);
    }

    const files = req.files || [];

    if (files.length === 0) {
      req.file = undefined;
      return next();
    }

    if (files.length > 1) {
      // If client attached multiple files with different names, prefer 'file' or 'customer_csv' if unique
      const preferred = files.find(
        (f) => f.fieldname === 'file' || f.fieldname === 'customer_csv'
      );
      if (preferred && files.filter((f) => f.fieldname === preferred.fieldname).length === 1 && files.length <= 2) {
        req.file = preferred;
        return next();
      }

      return next(
        new AppError('Only one CSV file can be uploaded per request.', 400)
      );
    }

    req.file = files[0];
    return next();
  });
}

module.exports = {
  uploadSingleCsv,
};
