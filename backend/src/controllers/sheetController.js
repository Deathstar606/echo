const path = require('node:path');
const { findBusinessOrThrow } = require('./businessController');
const {
  detectEntityFromCsv,
  createOrRegisterDynamicTableFromCsv,
  parseAndValidateProductsCsv,
  importProductsToDatabase,
  parseAndValidateSheetCsv,
  importSheetRecordsToDatabase,
  parseCsvBoolean,
} = require('../services/sheetCsvImportService');
const { getAllRows, executeSpreadsheetQuery } = require('../services/sheetQueryService');
const { interpretNaturalLanguageQuery } = require('../services/sheetQueryPromptBuilder');
const { executeMutation } = require('../services/sheetMutationService');
const {
  normalizeEntityName,
  discoverTableSchema,
  registerTableSchema,
  ensureTableExists,
  findColumnDef,
} = require('../services/sheetSchemaService');
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
 * POST /api/sheets/:entity/upload
 * POST /api/sheets/:entity/append
 * POST /api/sheets/upload
 * POST /api/sheets/append
 * POST /api/businesses/:businessId/sheets/:entity/upload
 * POST /api/businesses/:businessId/sheets/:entity/append
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
    const mode = String(
      req.query.mode ||
      req.body?.mode ||
      (req.path.includes('/append') ? 'append' : 'replace')
    ).toLowerCase();
    const isAppend = mode === 'append';

    const fileName = path.basename(req.file.originalname || 'sheet.csv');
    let targetEntity = req.params.entity || req.query.entity || req.body?.entity;

    // In replace mode, if entity was not specified OR if it was 'products' but CSV headers belong to another table,
    // auto-detect entity from CSV headers/filename
    if (!isAppend) {
      if (!targetEntity || targetEntity === 'products') {
        targetEntity = detectEntityFromCsv(req.file.buffer, fileName, targetEntity || 'products');
      } else {
        targetEntity = normalizeEntityName(targetEntity);
      }
    } else {
      targetEntity = normalizeEntityName(targetEntity || 'products');
    }

    const entity = normalizeEntityName(targetEntity);
    let schema;

    if (!isAppend && entity !== 'products') {
      // In replace mode for non-products sheets, always derive the active schema directly
      // from the uploaded CSV headers so NO imaginary columns are ever inherited or created!
      schema = await createOrRegisterDynamicTableFromCsv(entity, req.file.buffer, business.id);
      await ensureTableExists(schema);
    } else {
      try {
        schema = await discoverTableSchema(entity, business.id);
      } catch {
        schema = await createOrRegisterDynamicTableFromCsv(entity, req.file.buffer, business.id);
      }
      await ensureTableExists(schema);
    }

    // For products table
    if (entity === 'products') {
      let isApparelMatch = true;
      try {
        const { validRecords, rejectedRows, totalRows } = parseAndValidateProductsCsv(
          req.file.buffer,
          { mode }
        );

        if (validRecords.length === 0) {
          return res.status(400).json({
            error: 'All rows in the uploaded products CSV failed validation.',
            business_id: business.id,
            entity: 'products',
            displayName: 'Products (Apparel)',
            mode,
            source_file: fileName,
            total_rows: totalRows,
            imported_count: 0,
            rejected_count: rejectedRows.length,
            errors: rejectedRows,
          });
        }

        const importedCount = await importProductsToDatabase(business.id, validRecords, { mode });

        return res.status(200).json({
          message: isAppend
            ? (rejectedRows.length > 0
                ? `Appended ${importedCount} row(s) to Products sheet with some rejected rows.`
                : `Successfully appended ${importedCount} row(s) to Products sheet.`)
            : (rejectedRows.length > 0
                ? 'Products CSV processed with some rejected rows.'
                : 'Products CSV imported successfully.'),
          business_id: business.id,
          entity: 'products',
          displayName: 'Products (Apparel)',
          source_file: fileName,
          columns: [
            'name',
            'category',
            'description',
            'best',
            'color',
            'discount',
            'ordered',
            'images',
            'size',
            'price',
          ],
          mode,
          total_rows: totalRows,
          imported_count: importedCount,
          rejected_count: rejectedRows.length,
          errors: rejectedRows,
        });
      } catch (err) {
        // If CSV headers don't match the fixed products schema (e.g. missing name or price),
        // fallback smoothly to dynamic table schema so ANY arbitrary CSV can be uploaded!
        if (err.message && err.message.includes('Invalid products CSV headers')) {
          isApparelMatch = false;
        } else {
          throw err;
        }
      }

      if (!isApparelMatch) {
        const dynamicName = detectEntityFromCsv(req.file.buffer, fileName, 'custom_inventory');
        schema = await createOrRegisterDynamicTableFromCsv(dynamicName, req.file.buffer, business.id);
        await ensureTableExists(schema);
      }
    }

    // Dynamic CSV parser for any active inventory table
    const { validRecords, rejectedRows, totalRows } = parseAndValidateSheetCsv(
      req.file.buffer,
      schema,
      { mode }
    );

    if (validRecords.length === 0) {
      return res.status(400).json({
        error: `All rows in the uploaded ${schema.displayName} CSV failed validation.`,
        business_id: business.id,
        entity: schema.entity,
        displayName: schema.displayName,
        mode,
        source_file: fileName,
        total_rows: totalRows,
        imported_count: 0,
        rejected_count: rejectedRows.length,
        errors: rejectedRows,
      });
    }

    const importedCount = await importSheetRecordsToDatabase(
      business.id,
      schema,
      validRecords,
      { mode }
    );

    const activeColNames = Object.values(schema.columns)
      .filter(
        (c) =>
          !['id', 'business_id', 'created_at', 'updated_at'].includes(
            (c.exactName || '').toLowerCase()
          )
      )
      .map((c) => c.exactName || c);

    return res.status(200).json({
      message: isAppend
        ? (rejectedRows.length > 0
            ? `Appended ${importedCount} row(s) to ${schema.displayName} with some rejected rows.`
            : `Successfully appended ${importedCount} row(s) to ${schema.displayName}.`)
        : (rejectedRows.length > 0
            ? `${schema.displayName} CSV processed with some rejected rows.`
            : `${schema.displayName} CSV imported successfully.`),
      business_id: business.id,
      entity: schema.entity,
      displayName: schema.displayName,
      source_file: fileName,
      columns: activeColNames,
      mode,
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
 * GET /api/sheets/:entity
 * GET /api/businesses/:businessId/sheets/:entity
 */
async function getProductsList(req, res, next) {
  try {
    const business = await resolveBusiness(req);
    const rawEntity = req.params.entity || req.query.entity || 'products';
    const entity = normalizeEntityName(rawEntity);

    let schema;
    try {
      schema = await discoverTableSchema(entity, business.id);
    } catch {
      throw new AppError(`Sheet or table "${rawEntity}" not found.`, 404);
    }

    await ensureTableExists(schema);

    const rows = await getAllRows(entity, business.id);

    return res.status(200).json({
      status: 'ok',
      entity,
      displayName: schema.displayName,
      columns: Object.values(schema.columns)
        .filter(
          (c) =>
            !['id', 'business_id', 'created_at', 'updated_at'].includes(
              c.exactName.toLowerCase()
            )
        )
        .map((c) => c.exactName),
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
 * Body: { entity?: string, message: '...' }
 */
async function querySpreadsheet(req, res, next) {
  try {
    const body = req.body || {};
    const rawEntity = body.entity !== undefined ? body.entity : (req.params.entity || 'products');
    const rawMessage = body.message;

    if (!rawEntity || typeof rawEntity !== 'string') {
      throw new AppError('Field "entity" must be a valid entity string.', 400);
    }

    if (!rawMessage || typeof rawMessage !== 'string' || !rawMessage.trim()) {
      throw new AppError('Field "message" is required and must be a non-empty string.', 400);
    }

    const entity = normalizeEntityName(rawEntity);
    const business = await resolveBusiness(req);

    // Verify entity schema exists
    await discoverTableSchema(entity, business.id);

    // 1. Convert natural-language message to structured JSON query
    const interpreted = await interpretNaturalLanguageQuery({
      entity,
      message: rawMessage.trim(),
      isMutation: false,
      businessId: business.id,
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
 * Body: { entity?: string, message, confirm?: boolean } OR { entity?: string, mutation, confirm?: boolean }
 */
async function mutateSpreadsheet(req, res, next) {
  try {
    const body = req.body || {};
    const rawEntity = body.entity !== undefined ? body.entity : (req.params.entity || 'products');
    const confirm = Boolean(body.confirm);

    if (!rawEntity || typeof rawEntity !== 'string') {
      throw new AppError('Field "entity" must be a valid entity string.', 400);
    }

    const entity = normalizeEntityName(rawEntity);
    const business = await resolveBusiness(req);

    // Verify entity schema exists
    await discoverTableSchema(entity, business.id);

    let mutationJson = body.mutation;

    // If natural language message provided, interpret via LLM
    if (!mutationJson && typeof body.message === 'string' && body.message.trim()) {
      mutationJson = await interpretNaturalLanguageQuery({
        entity,
        message: body.message.trim(),
        isMutation: true,
        businessId: business.id,
      });
    }

    if (!mutationJson) {
      throw new AppError(
        'Provide either "message" (natural language) or structured "mutation" object.',
        400
      );
    }

    const expectedPreviewHash =
      body.expected_preview_hash || body.preview_hash || undefined;

    const result = await executeMutation({
      entity,
      businessId: business.id,
      mutationJson,
      confirm,
      expectedPreviewHash,
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
 * POST /api/sheets/:entity/row
 * POST /api/sheets/row
 * POST /api/businesses/:businessId/sheets/:entity/row
 *
 * Adds a single row with dynamic columns to the active table.
 * Body: { row: { [column]: value } } or { [column]: value }
 */
async function insertSheetRow(req, res, next) {
  try {
    const business = await resolveBusiness(req);
    const rawEntity = req.params.entity || req.query.entity || req.body?.entity || 'products';
    const entity = normalizeEntityName(rawEntity);

    const bodyRow = req.body?.row || req.body?.data || req.body;
    if (!bodyRow || typeof bodyRow !== 'object' || Array.isArray(bodyRow)) {
      throw new AppError('Field "row" must be an object containing column values.', 400);
    }

    // Filter out metadata fields and internal keys
    const cleanRowInput = {};
    for (const [key, val] of Object.entries(bodyRow)) {
      if (['entity', 'row', 'data', 'business_id', 'businessId', 'confirm'].includes(key)) {
        continue;
      }
      if (!['id', 'business_id', 'created_at', 'updated_at'].includes(key.toLowerCase())) {
        cleanRowInput[key] = val;
      }
    }

    if (Object.keys(cleanRowInput).length === 0) {
      throw new AppError('Cannot insert an empty row. Please provide at least one column value.', 400);
    }

    let schema;
    try {
      schema = await discoverTableSchema(entity, business.id);
    } catch {
      // Create and register schema on the fly from the submitted row columns
      const colDefs = {};
      for (const k of Object.keys(cleanRowInput)) {
        colDefs[k.toLowerCase()] = {
          exactName: k,
          type: typeof cleanRowInput[k] === 'number' ? 'number' : 'string',
        };
      }
      schema = {
        entity,
        tableName: entity,
        displayName: entity.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        columns: colDefs,
      };
      registerTableSchema(schema);
    }

    await ensureTableExists(schema);

    let insertedCount = 0;
    if (entity === 'products') {
      const bestParsed = parseCsvBoolean(cleanRowInput.best);
      const discountVal =
        cleanRowInput.discount !== undefined && cleanRowInput.discount !== ''
          ? Number(cleanRowInput.discount)
          : 0;
      const orderedVal =
        cleanRowInput.ordered !== undefined && cleanRowInput.ordered !== ''
          ? Number(cleanRowInput.ordered)
          : 0;
      const priceVal =
        cleanRowInput.price !== undefined && cleanRowInput.price !== ''
          ? Number(cleanRowInput.price)
          : 0;

      const productRecord = {
        name:
          cleanRowInput.name ||
          cleanRowInput['product name'] ||
          cleanRowInput['item name'] ||
          'Unnamed Product',
        category: cleanRowInput.category || null,
        description: cleanRowInput.description || null,
        best: bestParsed.valid ? bestParsed.value : false,
        color: cleanRowInput.color || null,
        discount: Number.isNaN(discountVal) ? 0 : discountVal,
        ordered: Number.isNaN(orderedVal) ? 0 : orderedVal,
        images: cleanRowInput.images || null,
        size:
          typeof cleanRowInput.size === 'object'
            ? JSON.stringify(cleanRowInput.size)
            : cleanRowInput.size || null,
        price: Number.isNaN(priceVal) ? 0 : priceVal,
      };

      insertedCount = await importProductsToDatabase(business.id, [productRecord], {
        mode: 'append',
      });
    } else {
      // Dynamic table: match columns to schema
      const record = {};
      for (const [colKey, rawVal] of Object.entries(cleanRowInput)) {
        const found = findColumnDef(schema, colKey);
        const colDef = found ? found.colDef : null;
        const physicalName = found ? found.exactName : colKey;
        if (rawVal === '' || rawVal === null || rawVal === undefined) {
          record[physicalName] = null;
        } else if (
          colDef &&
          (colDef.type === 'number' ||
            colDef.type === 'integer' ||
            colDef.type === 'decimal')
        ) {
          const num = Number(rawVal);
          record[physicalName] = Number.isNaN(num) ? rawVal : num;
        } else if (colDef && colDef.type === 'boolean') {
          const b = parseCsvBoolean(rawVal);
          record[physicalName] = b.valid ? b.value : rawVal;
        } else {
          record[physicalName] = rawVal;
        }
      }

      insertedCount = await importSheetRecordsToDatabase(business.id, schema, [record], {
        mode: 'append',
      });
    }

    const rows = await getAllRows(entity, business.id);

    return res.status(201).json({
      message: `Successfully added row to ${schema.displayName || entity}.`,
      entity,
      displayName: schema.displayName || entity,
      insertedCount,
      count: rows.length,
      rows,
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
  insertSheetRow,
};
