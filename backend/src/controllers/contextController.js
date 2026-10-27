const path = require('node:path');
const AppError = require('../utils/AppError');
const { findBusinessOrThrow } = require('./businessController');
const {
  parseAndValidateCsv,
  importContextRecords,
} = require('../services/csvImportService');

/**
 * POST /api/businesses/:businessId/context/upload
 * Validates that the business exists, parses and validates the uploaded CSV file,
 * and upserts context records into PostgreSQL inside a transaction.
 */
async function uploadBusinessContext(req, res, next) {
  try {
    const { businessId } = req.params;

    if (!req.file) {
      throw new AppError(
        'No CSV file uploaded. Please attach a .csv file under the form-data field name "file".',
        400
      );
    }

    // 1. Validate that the business exists before importing
    const business = await findBusinessOrThrow(businessId);

    // 2. Parse and validate the CSV headers and row values
    const records = parseAndValidateCsv(req.file.buffer);

    const sanitizedSourceFile = path.basename(
      req.file.originalname || 'uploaded.csv'
    );

    // 3. Save/update records in PostgreSQL within a transaction
    const summary = await importContextRecords(
      business.id,
      sanitizedSourceFile,
      records
    );

    return res.status(200).json({
      message: 'CSV context imported successfully.',
      businessId: business.id,
      businessName: business.name,
      sourceFile: sanitizedSourceFile,
      totalProcessed: summary.totalProcessed,
      insertedCount: summary.insertedCount,
      updatedCount: summary.updatedCount,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  uploadBusinessContext,
};
