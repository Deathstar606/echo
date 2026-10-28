const path = require('node:path');
const { findBusinessOrThrow } = require('./businessController');
const {
  parseAndValidateProductsCsv,
  parseAndValidateServicesCsv,
  importProductsToDatabase,
  importServicesToDatabase,
} = require('../services/sheetCsvImportService');
const { getAllRows, executeSpreadsheetQuery } = require('../services/sheetQueryService');
const { interpretNaturalLanguageQuery } = require('../services/sheetQueryPromptBuilder');
const { executeMutation, previewMutation } = require('../services/sheetMutationService');
const {
  generateSampleSheetDraft,
  saveGeneratedSheetRows,
} = require('../services/sheetGenerationService');
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
 * POST /api/sheets/services/upload
 * POST /api/businesses/:businessId/sheets/services/upload
 */
async function uploadServices(req, res, next) {
  try {
    if (!req.file) {
      throw new AppError(
        'No CSV file uploaded. Please attach a .csv file under form-data key "file" or "customer_csv".',
        400
      );
    }

    const business = await resolveBusiness(req);
    const fileName = path.basename(req.file.originalname || 'services.csv');

    const { validRecords, rejectedRows, totalRows } = parseAndValidateServicesCsv(req.file.buffer);

    if (validRecords.length === 0) {
      return res.status(400).json({
        error: 'All rows in the uploaded services CSV failed validation.',
        business_id: business.id,
        entity: 'services',
        source_file: fileName,
        total_rows: totalRows,
        imported_count: 0,
        rejected_count: rejectedRows.length,
        errors: rejectedRows,
      });
    }

    const importedCount = await importServicesToDatabase(business.id, validRecords);

    return res.status(200).json({
      message:
        rejectedRows.length > 0
          ? 'Services CSV processed with some rejected rows.'
          : 'Services CSV imported successfully.',
      business_id: business.id,
      entity: 'services',
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
 * GET /api/sheets/services
 * GET /api/businesses/:businessId/sheets/services
 */
async function getServicesList(req, res, next) {
  try {
    const business = await resolveBusiness(req);
    const rows = await getAllRows('services', business.id);

    return res.status(200).json({
      status: 'ok',
      entity: 'services',
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
 * Body: { entity: 'products' | 'services', message: '...' }
 */
async function querySpreadsheet(req, res, next) {
  try {
    const body = req.body || {};
    const rawEntity = body.entity;
    const rawMessage = body.message;

    if (!rawEntity || typeof rawEntity !== 'string') {
      throw new AppError('Field "entity" is required ("products" or "services").', 400);
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
 * Body: { entity, message, confirm?: boolean } OR { entity, mutation, confirm?: boolean }
 */
async function mutateSpreadsheet(req, res, next) {
  try {
    const body = req.body || {};
    const rawEntity = body.entity;
    const confirm = Boolean(body.confirm);

    if (!rawEntity || typeof rawEntity !== 'string') {
      throw new AppError('Field "entity" is required ("products" or "services").', 400);
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
      throw new AppError('Provide either "message" (natural language) or structured "mutation" object.', 400);
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

/**
 * POST /api/sheets/generate
 * POST /api/businesses/:businessId/sheets/generate
 *
 * Body: { entity: 'products' | 'services', count?: number, prompt?: string }
 */
async function generateSheetData(req, res, next) {
  try {
    const body = req.body || {};
    const rawEntity = body.entity;

    if (!rawEntity || typeof rawEntity !== 'string') {
      throw new AppError(
        'Field "entity" is required ("products" or "services").',
        400
      );
    }

    const entity = normalizeEntityName(rawEntity);
    const business = await resolveBusiness(req);

    const result = await generateSampleSheetDraft({
      entity,
      business,
      count: body.count || 5,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
    });

    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/sheets/generate/save
 * POST /api/businesses/:businessId/sheets/generate/save
 *
 * Body: { entity: 'products' | 'services', rows: [...], mode?: 'append' | 'replace', confirm: true }
 */
async function saveGeneratedSheetData(req, res, next) {
  try {
    const body = req.body || {};
    const rawEntity = body.entity;

    if (!rawEntity || typeof rawEntity !== 'string') {
      throw new AppError(
        'Field "entity" is required ("products" or "services").',
        400
      );
    }

    const entity = normalizeEntityName(rawEntity);
    const business = await resolveBusiness(req);

    const result = await saveGeneratedSheetRows({
      businessId: business.id,
      entity,
      rows: body.rows,
      mode: body.mode || 'append',
      confirm: Boolean(body.confirm),
    });

    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  uploadProducts,
  uploadServices,
  getProductsList,
  getServicesList,
  querySpreadsheet,
  mutateSpreadsheet,
  generateSheetData,
  saveGeneratedSheetData,
};
