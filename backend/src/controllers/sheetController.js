const path = require('node:path');
const { findBusinessOrThrow } = require('./businessController');
const {
  parseAndValidateProductsCsv,
  importProductsToDatabase,
} = require('../services/sheetCsvImportService');
const { getAllRows, executeSpreadsheetQuery } = require('../services/sheetQueryService');
const { interpretNaturalLanguageQuery } = require('../services/sheetQueryPromptBuilder');
const { executeMutation } = require('../services/sheetMutationService');
const { normalizeEntityName } = require('../services/sheetSchemaService');
const AppError = require('../utils/AppError');

const DEFAULT_BUSINESS_ID = '684a8863-5094-4c8b-9b15-c50c06335b7f';

/**
 * Resolves the target businessId from route params, query, body, or default.
 * Validates that the business exists in PostgreSQL.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ id: string, name: string }>}
 */
async function resolveBusiness(req) {
  const candidateId =
    req.params.businessId ||
    req.query.business_id ||
    req.query.businessId ||
    req.body?.business_id ||
    req.body?.businessId ||
    req.headers['x-business-id'] ||
    DEFAULT_BUSINESS_ID;

  return findBusinessOrThrow(String(candidateId).trim());
}

/**
 * POST /api/sheets/products/upload
 * POST /api/businesses/:businessId/sheets/products/upload
 */
async function uploadProducts(req, res, next) {
  try {
    if (!req.file) {
      throw new AppError(
        'No CSV file uploaded. Please attach a .csv file under form-data key "file" or "customer_csv".',
        400
      );
    }

    const business = await resolveBusiness(req);
    const fileName = path.basename(req.file.originalname || 'products.csv');

    const { validRecords, rejectedRows, totalRows } = parseAndValidateProductsCsv(req.file.buffer);

    if (validRecords.length === 0) {
      return res.status(400).json({
        error: 'All rows in the uploaded products CSV failed validation.',
        business_id: business.id,
        entity: 'products',
        source_file: fileName,
        total_rows: totalRows,
        imported_count: 0,
        rejected_count: rejectedRows.length,
        errors: rejectedRows,
      });
    }

    const importedCount = await importProductsToDatabase(business.id, validRecords);

    return res.status(200).json({
      message:
        rejectedRows.length > 0
          ? 'Products CSV processed with some rejected rows.'
          : 'Products CSV imported successfully.',
      business_id: business.id,
      entity: 'products',
      source_file: fileName,
      total_rows: totalRows,
      imported_count: importedCount,
      rejected_count: rejectedRows.length,
      errors: rejectedRows,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/sheets/products
 * GET /api/businesses/:businessId/sheets/products
 */
async function getProductsList(req, res, next) {
  try {
    const business = await resolveBusiness(req);
    const rows = await getAllRows('products', business.id);

    return res.status(200).json({
      status: 'ok',
      entity: 'products',
      business_id: business.id,
      rows,
      count: rows.length,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/sheets/query
 * POST /api/businesses/:businessId/sheets/query
 *
 * Body: { entity?: 'products', message: '...' }
 */
async function querySpreadsheet(req, res, next) {
  try {
    const body = req.body || {};
    const rawEntity = body.entity !== undefined ? body.entity : 'products';
    const rawMessage = body.message;

    if (!rawEntity || typeof rawEntity !== 'string') {
      throw new AppError('Field "entity" must be "products".', 400);
    }

    if (!rawMessage || typeof rawMessage !== 'string' || !rawMessage.trim()) {
      throw new AppError('Field "message" is required and must be a non-empty string.', 400);
    }

    const entity = normalizeEntityName(rawEntity);
    const business = await resolveBusiness(req);

    // 1. Convert natural-language message to structured JSON query
    const interpreted = await interpretNaturalLanguageQuery({
      entity,
      message: rawMessage.trim(),
      isMutation: false,
    });

    // 2. Execute query against PostgreSQL (or return clarification response)
    const result = await executeSpreadsheetQuery({
      entity,
      businessId: business.id,
      queryJson: interpreted,
    });

    return res.status(200).json({
      ...result,
      business_id: business.id,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/sheets/mutate
 * POST /api/sheets/mutation
 * POST /api/businesses/:businessId/sheets/mutate
 *
 * Body: { entity?: 'products', message, confirm?: boolean } OR { entity?: 'products', mutation, confirm?: boolean }
 */
async function mutateSpreadsheet(req, res, next) {
  try {
    const body = req.body || {};
    const rawEntity = body.entity !== undefined ? body.entity : 'products';
    const confirm = Boolean(body.confirm);

    if (!rawEntity || typeof rawEntity !== 'string') {
      throw new AppError('Field "entity" must be "products".', 400);
    }

    const entity = normalizeEntityName(rawEntity);
    const business = await resolveBusiness(req);

    let mutationJson = body.mutation;

    // If natural language message provided, interpret via LLM
    if (!mutationJson && typeof body.message === 'string' && body.message.trim()) {
      mutationJson = await interpretNaturalLanguageQuery({
        entity,
        message: body.message.trim(),
        isMutation: true,
      });
    }

    if (!mutationJson) {
      throw new AppError(
        'Provide either "message" (natural language) or structured "mutation" object.',
        400
      );
    }

    const result = await executeMutation({
      entity,
      businessId: business.id,
      mutationJson,
      confirm,
    });

    return res.status(200).json({
      ...result,
      business_id: business.id,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  uploadProducts,
  getProductsList,
  querySpreadsheet,
  mutateSpreadsheet,
};
