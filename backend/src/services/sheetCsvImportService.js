const path = require('node:path');
const { parse } = require('csv-parse/sync');
const { query, withTransaction } = require('../../db');
const {
  findColumnDef,
  getSchema,
  registerTableSchema,
  normalizeEntityName,
  isEntitySupported,
  ensureTableExists,
} = require('./sheetSchemaService');
const AppError = require('../utils/AppError');

/**
 * Detects which table/entity a CSV file belongs to based on its headers and filename.
 * Supports:
 * - products (apparel)
 * - electronics_inventory
 * - grocery_inventory
 * - any registered or dynamically discovered table
 *
 * @param {Buffer} fileBuffer
 * @param {string} [filename]
 * @param {string} [fallbackEntity]
 * @returns {string} Detected entity name
 */
function detectEntityFromCsv(fileBuffer, filename = '', fallbackEntity = 'products') {
  if (!fileBuffer || fileBuffer.length === 0) return fallbackEntity;

  let headers = [];
  try {
    const rows = parse(fileBuffer, {
      bom: true,
      to_line: 2,
      skip_empty_lines: true,
    });
    if (rows && rows.length > 0) {
      headers = rows[0].map((h) => String(h ?? '').trim().toLowerCase());
    }
  } catch {
    return fallbackEntity;
  }

  const cleanFilename = String(filename || '').toLowerCase();
  const baseName = path.basename(cleanFilename, '.csv').replace(/[^a-z0-9_]/g, '_');
  const genericNames = ['sheet', 'file', 'data', 'upload', 'test', 'sample', 'export'];
  const isGeneric = !baseName || genericNames.includes(baseName);

  // 1. Products (Apparel) check:
  // If the CSV has apparel headers (e.g. 'name' and ('price' or other apparel signals)), it belongs to products
  const productsSignals = ['name', 'price', 'discount', 'category', 'color', 'size', 'ordered', 'best'];
  const productsMatchCount = productsSignals.filter((s) => headers.includes(s)).length;
  if (headers.includes('name') && (headers.includes('price') || productsMatchCount >= 2)) {
    return 'products';
  }

  // 2. If filename has a specific, non-generic table name, prioritize the uploaded file's identity!
  // e.g. cake_inventory.csv -> cake_inventory, handbag_inventory.csv -> handbag_inventory
  if (!isGeneric) {
    if (baseName === 'products') {
      return headers.length > 0 ? 'custom_inventory' : 'products';
    }
    return baseName;
  }

  // 3. Generic filename (e.g. data.csv, upload.csv, sheet.csv):
  // Detect entity based on header & content heuristics

  // Electronics inventory signals
  const electronicsSignals = [
    'product_name',
    'brand_name',
    'model',
    'current_price',
    'stock_qty',
    'reorder_level',
    'warranty_months',
  ];
  const electronicsMatchCount = electronicsSignals.filter((s) => headers.includes(s)).length;
  if (electronicsMatchCount >= 2 || cleanFilename.includes('electronic')) {
    return 'electronics_inventory';
  }

  // Grocery inventory signals
  const grocerySignals = [
    'item_name',
    'supplier',
    'unit_cost',
    'selling_price',
    'expiry_date',
    'batch_no',
    'warehouse_location',
  ];
  const groceryMatchCount = grocerySignals.filter((s) => headers.includes(s)).length;
  if (groceryMatchCount >= 2 || cleanFilename.includes('grocer')) {
    return 'grocery_inventory';
  }

  // 4. Check if fallbackEntity matches
  if (fallbackEntity && fallbackEntity !== 'products') {
    return normalizeEntityName(fallbackEntity);
  }

  // If CSV does not have 'name' column and contains data, derive dynamic table name instead of forcing 'products'
  if (!headers.includes('name') && headers.length > 0) {
    return baseName || 'custom_inventory';
  }

  return 'products';
}

/**
 * Automatically creates/registers a dynamic table and schema for an arbitrary CSV upload
 * if the table is not already in the schema registry.
 *
 * @param {string} entityName
 * @param {Buffer} fileBuffer
 * @param {string} [businessId]
 * @returns {Promise<object>} Table schema definition
 */
async function createOrRegisterDynamicTableFromCsv(entityName, fileBuffer, businessId) {
  const normName = normalizeEntityName(entityName);
  let rows;
  try {
    // Only parse the first 50 lines for dynamic table detection and column inference.
    // This avoids parsing megabytes of data when registering dynamic schemas.
    rows = parse(fileBuffer, {
      bom: true,
      skip_empty_lines: true,
      to_line: 50,
    });
  } catch (err) {
    throw new AppError(`Malformed CSV file: ${err.message}`, 400);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AppError('Uploaded CSV file is empty.', 400);
  }

  const rawHeaders = rows[0].map((h) => String(h ?? '').trim());
  const columns = {
    id: {
      exactName: 'id',
      type: 'uuid',
      readonly: true,
      modifiable: false,
      queryable: true,
      sortable: false,
      operators: ['equals', 'not_equals', 'in'],
    },
    business_id: { exactName: 'business_id', type: 'uuid', readonly: true, modifiable: false },
  };

  const sampleRows = rows.slice(1, 15);
  const columnDefsSql = [];

  for (let c = 0; c < rawHeaders.length; c += 1) {
    const rawCol = rawHeaders[c];
    if (!rawCol) continue;
    const cleanKey = rawCol.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (['id', 'business_id', 'created_at', 'updated_at'].includes(cleanKey)) continue;

    // Detect column type from sample rows
    let isNumeric = sampleRows.length > 0;
    let isInteger = sampleRows.length > 0;
    let isBoolean = sampleRows.length > 0;
    let isDate = sampleRows.length > 0;

    for (const r of sampleRows) {
      const val = String(r[c] ?? '').trim();
      if (!val) continue;

      const cleanedNum = val.replace(/[$,%\s]/g, '');
      const num = Number(cleanedNum);
      if (!Number.isFinite(num)) {
        isNumeric = false;
        isInteger = false;
      } else if (!Number.isInteger(num)) {
        isInteger = false;
      }

      // Preserve numbers with leading zeroes (e.g. '01712345678' or '00123') or >15 digits as strings
      if (val.length > 15 || (val.startsWith('0') && val.length > 1 && !val.includes('.'))) {
        isInteger = false;
        isNumeric = false;
      }

      const bLow = val.toLowerCase();
      if (!['true', 'false', '1', '0', 'yes', 'no'].includes(bLow)) {
        isBoolean = false;
      }

      if (!/^\d{4}-\d{2}-\d{2}/.test(val) || Number.isNaN(Date.parse(val))) {
        isDate = false;
      }
    }

    let colType = 'string';
    let pgType = 'VARCHAR(255)';
    if (isBoolean && !isNumeric) {
      colType = 'boolean';
      pgType = 'BOOLEAN';
    } else if (isInteger) {
      colType = 'integer';
      // Use 64-bit BIGINT in PostgreSQL so values > 2,147,483,647 (e.g. student IDs) never overflow
      pgType = 'BIGINT';
    } else if (isNumeric) {
      colType = 'number';
      pgType = 'NUMERIC(18, 2)';
    } else if (isDate) {
      colType = 'date';
      pgType = 'DATE';
    }

    columns[cleanKey] = {
      exactName: rawCol,
      type: colType,
      required: false,
      modifiable: true,
      queryable: true,
      sortable: true,
      operators:
        colType === 'number' || colType === 'integer'
          ? [
              'equals',
              'not_equals',
              'greater_than',
              'greater_than_or_equal',
              'less_than',
              'less_than_or_equal',
              'between',
            ]
          : colType === 'boolean'
            ? ['equals', 'not_equals']
            : colType === 'date'
              ? [
                  'equals',
                  'not_equals',
                  'greater_than',
                  'greater_than_or_equal',
                  'less_than',
                  'less_than_or_equal',
                  'between',
                ]
              : [
                  'equals',
                  'not_equals',
                  'contains',
                  'not_contains',
                  'starts_with',
                  'ends_with',
                  'in',
                ],
    };

    columnDefsSql.push(`"${rawCol}" ${pgType}`);
  }

  columns.created_at = {
    exactName: 'created_at',
    type: 'date',
    readonly: true,
    queryable: true,
    sortable: true,
    operators: [
      'equals',
      'not_equals',
      'greater_than',
      'greater_than_or_equal',
      'less_than',
      'less_than_or_equal',
    ],
  };
  columns.updated_at = {
    exactName: 'updated_at',
    type: 'date',
    readonly: true,
    modifiable: false,
  };

  const dynamicSchema = {
    entity: normName,
    tableName: normName,
    displayName: normName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    columns,
    representativeValues: {},
  };

  registerTableSchema(normName, dynamicSchema);

  // Dynamically ensure the table and its columns exist in PostgreSQL
  await ensureTableExists(dynamicSchema);

  return dynamicSchema;
}

/**
 * Parses a boolean string from CSV ('True', 'False', 'true', 'false', '1', '0', 'yes', 'no').
 * Returns { valid: boolean, value: boolean }.
 */
function parseCsvBoolean(rawVal) {
  if (rawVal === undefined || rawVal === null || String(rawVal).trim() === '') {
    return { valid: true, value: false };
  }
  const clean = String(rawVal).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(clean)) {
    return { valid: true, value: true };
  }
  if (['false', '0', 'no', 'n'].includes(clean)) {
    return { valid: true, value: false };
  }
  return { valid: false, value: false };
}

/**
 * Parses and validates a products CSV buffer matching backend/products.csv structure:
 * Columns: name, category, description, best, color, discount, ordered, images, size, price
 *
 * @param {Buffer} fileBuffer
 * @param {{ mode?: 'replace' | 'append' }} [options]
 * @returns {{ validRecords: any[], rejectedRows: any[], totalRows: number }}
 */
function parseAndValidateProductsCsv(fileBuffer, options = {}) {
  const mode = options.mode || 'replace';
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new AppError('Uploaded CSV file is empty.', 400);
  }

  let rows;
  try {
    rows = parse(fileBuffer, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      relax_quotes: false,
    });
  } catch (err) {
    throw new AppError(`Malformed CSV file: ${err.message}`, 400);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AppError('Uploaded CSV file is empty.', 400);
  }

  const rawHeaders = rows[0].map((h) =>
    String(h ?? '')
      .trim()
      .toLowerCase()
  );

  const requiredCols = ['name', 'price'];
  const missing = requiredCols.filter((c) => !rawHeaders.includes(c));
  if (missing.length > 0) {
    throw new AppError(
      `Invalid products CSV headers. Missing required column(s): ${missing.join(', ')}. Required columns: name, price (supported columns: name, category, description, best, color, discount, ordered, images, size, price).`,
      400
    );
  }

  // In append mode, ensure headers match products schema
  if (mode === 'append') {
    const productExpectedCols = [
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
    ];
    // Check if the uploaded file has columns completely alien to products
    const matchingCount = productExpectedCols.filter((c) => rawHeaders.includes(c)).length;
    if (matchingCount < 2) {
      throw new AppError(
        `Invalid CSV headers for append. Uploaded row columns do not match active sheet (Products). Expected columns: ${productExpectedCols.join(', ')}.`,
        400
      );
    }
  }

  const nameIdx = rawHeaders.indexOf('name');
  const catIdx = rawHeaders.indexOf('category');
  const descIdx = rawHeaders.indexOf('description');
  const bestIdx = rawHeaders.indexOf('best');
  const colorIdx = rawHeaders.indexOf('color');
  const discountIdx = rawHeaders.indexOf('discount');
  const orderedIdx = rawHeaders.indexOf('ordered');
  const imagesIdx = rawHeaders.indexOf('images');
  const sizeIdx = rawHeaders.indexOf('size');
  const priceIdx = rawHeaders.indexOf('price');
  const createdIdx = rawHeaders.indexOf('created_at');

  const validRecords = [];
  const rejectedRows = [];
  let totalRows = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNum = i + 1;

    const rawName = String(row[nameIdx] ?? '').trim();
    const rawCat = catIdx !== -1 ? String(row[catIdx] ?? '').trim() : '';
    const rawDesc = descIdx !== -1 ? String(row[descIdx] ?? '').trim() : '';
    const rawBest = bestIdx !== -1 ? String(row[bestIdx] ?? '').trim() : '';
    const rawColor = colorIdx !== -1 ? String(row[colorIdx] ?? '').trim() : '';
    const rawDiscount =
      discountIdx !== -1 ? String(row[discountIdx] ?? '').trim() : '';
    const rawOrdered =
      orderedIdx !== -1 ? String(row[orderedIdx] ?? '').trim() : '';
    const rawImages =
      imagesIdx !== -1 ? String(row[imagesIdx] ?? '').trim() : '';
    const rawSize = sizeIdx !== -1 ? String(row[sizeIdx] ?? '').trim() : '';
    const rawPrice = String(row[priceIdx] ?? '').trim();
    const rawCreated =
      createdIdx !== -1 ? String(row[createdIdx] ?? '').trim() : '';

    // Skip entirely empty lines
    if (!rawName && !rawPrice && !rawDesc && !rawCat) {
      continue;
    }

    totalRows += 1;
    const rowErrors = [];

    if (!rawName) {
      rowErrors.push('missing required "name"');
    }

    const cleanedPrice = rawPrice.replace(/[$,\s]/g, '');
    const priceNum = cleanedPrice === '' ? Number.NaN : Number(cleanedPrice);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      rowErrors.push(
        `invalid "price" (${rawPrice}), must be a non-negative number`
      );
    }

    let discountNum = 0;
    if (rawDiscount !== '') {
      const cleanedDiscount = rawDiscount.replace(/[%\s]/g, '');
      discountNum = Number(cleanedDiscount);
      if (
        !Number.isFinite(discountNum) ||
        discountNum < 0 ||
        discountNum > 100
      ) {
        rowErrors.push(
          `invalid "discount" (${rawDiscount}), must be a number between 0 and 100`
        );
      }
    }

    let orderedNum = 0;
    if (rawOrdered !== '') {
      const parsedOrd = Number(rawOrdered);
      if (
        !Number.isFinite(parsedOrd) ||
        parsedOrd < 0 ||
        !Number.isInteger(parsedOrd)
      ) {
        rowErrors.push(
          `invalid "ordered" (${rawOrdered}), must be a non-negative integer`
        );
      } else {
        orderedNum = parsedOrd;
      }
    }

    const parsedBest = parseCsvBoolean(rawBest);
    if (!parsedBest.valid) {
      rowErrors.push(
        `invalid "best" (${rawBest}), must be True or False`
      );
    }

    let normalizedSize = rawSize || null;
    if (rawSize && rawSize.startsWith('{')) {
      try {
        const parsedSizeObj = JSON.parse(rawSize);
        normalizedSize = JSON.stringify(parsedSizeObj);
      } catch {
        rowErrors.push(`invalid JSON in "size" (${rawSize})`);
      }
    }

    let parsedCreatedAt = null;
    if (rawCreated) {
      const d = new Date(rawCreated);
      if (Number.isNaN(d.getTime())) {
        rowErrors.push(`invalid "created_at" date format (${rawCreated})`);
      } else {
        parsedCreatedAt = d.toISOString();
      }
    }

    if (rowErrors.length > 0) {
      rejectedRows.push({
        row: rowNum,
        name: rawName,
        error: `Row ${rowNum}: ${rowErrors.join('; ')}.`,
      });
      continue;
    }

    validRecords.push({
      name: rawName,
      category: rawCat || null,
      description: rawDesc || null,
      best: parsedBest.value,
      color: rawColor || null,
      discount: discountNum,
      ordered: orderedNum,
      images: rawImages || null,
      size: normalizedSize,
      price: priceNum,
      created_at: parsedCreatedAt,
    });
  }

  if (totalRows === 0) {
    throw new AppError(
      'CSV file contains headers but no data rows to import.',
      400
    );
  }

  return { validRecords, rejectedRows, totalRows };
}

/**
 * Imports products CSV into PostgreSQL for a business.
 * Discards existing products for this business in replace mode; appends in append mode.
 *
 * @param {string} businessId
 * @param {Array<object>} validRecords
 * @param {{ mode?: 'replace' | 'append' }} [options]
 * @returns {Promise<number>} count of imported records
 */
async function importProductsToDatabase(businessId, validRecords, options = {}) {
  const mode = options.mode || 'replace';
  if (!validRecords || validRecords.length === 0) return 0;

  return withTransaction(async (client) => {
    await ensureTableExists('products', client);

    if (mode === 'replace') {
      // Discard existing products for this business so the new copy is the only copy
      await client.query('DELETE FROM products WHERE business_id = $1;', [
        businessId,
      ]);
    }

    const colsSql = `
      business_id,
      name,
      category,
      description,
      best,
      color,
      discount,
      ordered,
      images,
      size,
      price,
      created_at,
      updated_at
    `;

    // 12 parameterized fields per row.
    // Chunk into batches of up to 500 rows to minimize remote DB network roundtrips.
    const paramsPerRow = 12;
    const batchSize = Math.max(1, Math.min(500, Math.floor(10000 / paramsPerRow)));
    let totalInserted = 0;

    for (let i = 0; i < validRecords.length; i += batchSize) {
      const batch = validRecords.slice(i, i + batchSize);
      const values = [];
      const rowTuples = [];

      for (let r = 0; r < batch.length; r += 1) {
        const rec = batch[r];
        const rowPlaceholders = [];

        // 1: business_id
        values.push(businessId);
        rowPlaceholders.push(`$${values.length}`);

        // 2: name
        values.push(rec.name);
        rowPlaceholders.push(`$${values.length}`);

        // 3: category
        values.push(rec.category);
        rowPlaceholders.push(`$${values.length}`);

        // 4: description
        values.push(rec.description);
        rowPlaceholders.push(`$${values.length}`);

        // 5: best
        values.push(Boolean(rec.best));
        rowPlaceholders.push(`$${values.length}`);

        // 6: color
        values.push(rec.color);
        rowPlaceholders.push(`$${values.length}`);

        // 7: discount
        values.push(rec.discount ?? 0);
        rowPlaceholders.push(`$${values.length}`);

        // 8: ordered
        values.push(rec.ordered ?? 0);
        rowPlaceholders.push(`$${values.length}`);

        // 9: images
        values.push(rec.images);
        rowPlaceholders.push(`$${values.length}`);

        // 10: size
        values.push(rec.size);
        rowPlaceholders.push(`$${values.length}`);

        // 11: price
        values.push(rec.price);
        rowPlaceholders.push(`$${values.length}`);

        // 12: created_at
        values.push(rec.created_at || null);
        const createdAtParam = `$${values.length}`;
        rowPlaceholders.push(`COALESCE(${createdAtParam}::timestamptz, NOW())`);

        // 13: updated_at (SQL literal)
        rowPlaceholders.push('NOW()');

        rowTuples.push(`(${rowPlaceholders.join(', ')})`);
      }

      const batchInsertSql = `
        INSERT INTO products (
          ${colsSql}
        )
        VALUES ${rowTuples.join(', ')}
        RETURNING id;
      `;

      const result = await client.query(batchInsertSql, values);
      totalInserted += (result && result.rowCount) ? result.rowCount : batch.length;
    }

    return totalInserted;
  });
}

/**
 * Parses and validates an arbitrary sheet CSV against the active table schema.
 * Supports replace and append modes with strict column validation for append.
 *
 * @param {Buffer} fileBuffer
 * @param {object} schema
 * @param {{ mode?: 'replace' | 'append' }} [options]
 * @returns {{ validRecords: any[], rejectedRows: any[], totalRows: number }}
 */
function parseAndValidateSheetCsv(fileBuffer, schema, options = {}) {
  const mode = options.mode || 'replace';
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new AppError('Uploaded CSV file is empty.', 400);
  }

  let rows;
  try {
    rows = parse(fileBuffer, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      relax_quotes: false,
    });
  } catch (err) {
    throw new AppError(`Malformed CSV file: ${err.message}`, 400);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AppError('Uploaded CSV file is empty.', 400);
  }

  const rawHeaders = rows[0].map((h) => String(h ?? '').trim());

  // Strict column validation in append mode:
  // "Make sure the new row has the same colums names of the active csv file"
  if (mode === 'append') {
    const activeCols = Object.values(schema.columns)
      .filter(
        (c) =>
          !['id', 'business_id', 'created_at', 'updated_at'].includes(
            c.exactName.toLowerCase()
          )
      )
      .map((c) => c.exactName);

    const missing = [];
    for (const exp of activeCols) {
      const match = rawHeaders.find(
        (h) => h.toLowerCase() === exp.toLowerCase()
      );
      if (!match) {
        missing.push(exp);
      }
    }

    if (missing.length > 0) {
      throw new AppError(
        `Invalid CSV headers for append. Uploaded row columns do not match active sheet (${schema.displayName}). Missing column(s): ${missing.join(', ')}. Expected columns: ${activeCols.join(', ')}.`,
        400
      );
    }
  }

  const headerMap = [];

  for (let i = 0; i < rawHeaders.length; i += 1) {
    const rawHeader = rawHeaders[i];
    if (!rawHeader) continue;
    let match = findColumnDef(schema, rawHeader);
    if (!match && mode === 'replace') {
      const cleanKey = rawHeader.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const newDef = {
        exactName: rawHeader,
        type: 'string',
        required: false,
        modifiable: true,
        queryable: true,
        sortable: true,
        operators: [
          'equals',
          'not_equals',
          'contains',
          'not_contains',
          'starts_with',
          'ends_with',
          'in',
        ],
      };
      schema.columns[cleanKey] = newDef;
      match = { exactName: rawHeader, colDef: newDef, key: cleanKey };
    }
    if (match) {
      headerMap.push({ index: i, exactName: match.exactName, colDef: match.colDef });
    }
  }

  if (headerMap.length === 0) {
    throw new AppError(
      `No matching columns found in uploaded CSV for sheet ${schema.displayName}.`,
      400
    );
  }

  const validRecords = [];
  const rejectedRows = [];
  let totalRows = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNum = i + 1;
    totalRows += 1;

    const rowErrors = [];
    const record = {};

    for (const mapping of headerMap) {
      const rawVal = row[mapping.index] !== undefined ? String(row[mapping.index]).trim() : '';
      const colDef = mapping.colDef;
      const colName = mapping.exactName;

      if (colDef.required && !rawVal) {
        rowErrors.push(`missing required "${colName}"`);
        continue;
      }

      if (!rawVal) {
        record[colName] = null;
        continue;
      }

      if (colDef.type === 'number' || colDef.type === 'integer') {
        const cleaned = rawVal.replace(/[$,%\s]/g, '');
        const num = cleaned === '' ? Number.NaN : Number(cleaned);
        if (!Number.isFinite(num)) {
          if (colDef.required) {
            rowErrors.push(`invalid "${colName}" (${rawVal}), must be numeric`);
          } else {
            record[colName] = rawVal;
          }
        } else if (colDef.min !== undefined && num < colDef.min) {
          rowErrors.push(`"${colName}" must be >= ${colDef.min}`);
        } else {
          record[colName] = colDef.type === 'integer' ? Math.round(num) : num;
        }
      } else if (colDef.type === 'boolean') {
        const boolParsed = parseCsvBoolean(rawVal);
        record[colName] = boolParsed.value;
      } else {
        record[colName] = rawVal;
      }
    }

    if (rowErrors.length > 0) {
      rejectedRows.push({ row_number: rowNum, errors: rowErrors });
    } else {
      validRecords.push(record);
    }
  }

  return { validRecords, rejectedRows, totalRows };
}

/**
 * Imports arbitrary sheet records into PostgreSQL for a business.
 * Discards existing records in replace mode; appends without deleting in append mode.
 * Introspects physical PostgreSQL columns to preserve case-sensitivity and prevent 42703 column errors.
 *
 * @param {string} businessId
 * @param {object} schema
 * @param {Array<object>} validRecords
 * @param {{ mode?: 'replace' | 'append' }} [options]
 * @returns {Promise<number>} count of imported records
 */
async function importSheetRecordsToDatabase(businessId, schema, validRecords, options = {}) {
  const mode = options.mode || 'replace';
  if (!validRecords || validRecords.length === 0) return 0;

  return withTransaction(async (client) => {
    await ensureTableExists(schema, client);

    const safeTableName = String(schema.tableName || 'products').replace(/[^a-z0-9_]/gi, '_');

    if (mode === 'replace') {
      await client.query(`DELETE FROM "${safeTableName}" WHERE business_id = $1;`, [businessId]);
    }

    // Introspect physical column names and data types in PostgreSQL
    const pgColsMap = new Map(); // lowercase name -> exact physical column name in pg
    const pgColTypesMap = new Map(); // lowercase name -> physical data_type in pg
    try {
      const colRes = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND LOWER(table_name) = LOWER($1);`,
        [safeTableName]
      );
      if (colRes.rows && colRes.rows.length > 0) {
        for (const row of colRes.rows) {
          const lower = String(row.column_name).toLowerCase();
          pgColsMap.set(lower, String(row.column_name));
          pgColTypesMap.set(lower, String(row.data_type || '').toLowerCase());
        }
      }
    } catch {
      // Mock pool or query error fallback
    }

    // Automatically widen any pre-existing 32-bit INTEGER or SMALLINT columns to BIGINT
    // so values > 2,147,483,647 (e.g. Student IDs, big counts) never fail with 22003 out of range errors
    for (const [lowerCol, physicalCol] of pgColsMap.entries()) {
      if (['id', 'business_id', 'created_at', 'updated_at'].includes(lowerCol)) continue;
      const currentType = pgColTypesMap.get(lowerCol);
      if (currentType === 'integer' || currentType === 'smallint') {
        try {
          await client.query(
            `ALTER TABLE "${safeTableName}" ALTER COLUMN "${physicalCol}" TYPE BIGINT, ALTER COLUMN "${physicalCol}" DROP NOT NULL;`
          );
        } catch {
          // Best-effort column widening
        }
      }
    }

    // If pgColsMap is empty (e.g. mock unit-test pools), populate from schema.columns
    if (pgColsMap.size === 0 && schema && schema.columns) {
      for (const colDef of Object.values(schema.columns)) {
        const raw = colDef.exactName || colDef.name;
        if (raw) pgColsMap.set(raw.toLowerCase(), raw);
      }
    }

    // Dynamically ensure any column from validRecords exists in PostgreSQL table
    const allRecordKeys = new Set();
    for (const rec of validRecords) {
      for (const k of Object.keys(rec)) {
        allRecordKeys.add(k);
      }
    }

    const missingCols = [];
    for (const k of allRecordKeys) {
      const cleanKey = String(k).replace(/[^a-z0-9_]/gi, '_');
      if (!pgColsMap.has(cleanKey.toLowerCase())) {
        missingCols.push(cleanKey);
        pgColsMap.set(cleanKey.toLowerCase(), cleanKey);
      }
    }

    if (missingCols.length > 0) {
      try {
        const alterClauses = missingCols.map((c) => `ADD COLUMN IF NOT EXISTS "${c}" TEXT`).join(', ');
        await client.query(`ALTER TABLE "${safeTableName}" ${alterClauses};`);
      } catch {
        // Fallback or mock pool
      }
    }

    // Fixed column list for multi-row batch insert
    const businessIdCol = pgColsMap.get('business_id') || 'business_id';
    const insertCols = [`"${businessIdCol}"`];
    const keyPhysicalMap = [];

    for (const k of allRecordKeys) {
      const cleanKey = String(k).replace(/[^a-z0-9_]/gi, '_');
      const physicalCol = pgColsMap.get(cleanKey.toLowerCase()) || cleanKey;
      insertCols.push(`"${physicalCol}"`);
      keyPhysicalMap.push({ key: k, physicalCol });
    }

    const hasCreatedAt = Boolean(schema.columns && schema.columns.created_at);
    const hasUpdatedAt = Boolean(schema.columns && schema.columns.updated_at);

    if (hasCreatedAt) {
      const createdAtCol = pgColsMap.get('created_at') || 'created_at';
      insertCols.push(`"${createdAtCol}"`);
    }
    if (hasUpdatedAt) {
      const updatedAtCol = pgColsMap.get('updated_at') || 'updated_at';
      insertCols.push(`"${updatedAtCol}"`);
    }

    const colsSql = insertCols.join(', ');
    const paramsPerRow = 1 + keyPhysicalMap.length;
    // Chunk into batches of up to 500 rows to minimize remote cloud DB network roundtrips.
    // PostgreSQL has a limit of 65,535 parameters; 10,000 parameter budget keeps batches safe and lightning-fast.
    const batchSize = Math.max(1, Math.min(500, Math.floor(10000 / paramsPerRow)));

    let totalInserted = 0;

    for (let i = 0; i < validRecords.length; i += batchSize) {
      const batch = validRecords.slice(i, i + batchSize);
      const values = [];
      const rowTuples = [];

      for (let r = 0; r < batch.length; r += 1) {
        const rec = batch[r];
        const rowPlaceholders = [];

        // 1. business_id
        values.push(businessId);
        rowPlaceholders.push(`$${values.length}`);

        // 2. record columns
        for (let c = 0; c < keyPhysicalMap.length; c += 1) {
          const val = rec[keyPhysicalMap[c].key];
          values.push(val !== undefined ? val : null);
          rowPlaceholders.push(`$${values.length}`);
        }

        // 3. created_at & updated_at (using NOW() SQL literal)
        if (hasCreatedAt) {
          rowPlaceholders.push('NOW()');
        }
        if (hasUpdatedAt) {
          rowPlaceholders.push('NOW()');
        }

        rowTuples.push(`(${rowPlaceholders.join(', ')})`);
      }

      const batchInsertSql = `
        INSERT INTO "${safeTableName}" (${colsSql})
        VALUES ${rowTuples.join(', ')}
        RETURNING id;
      `;

      const result = await client.query(batchInsertSql, values);
      totalInserted += (result && result.rowCount) ? result.rowCount : batch.length;
    }

    return totalInserted;
  });
}

module.exports = {
  detectEntityFromCsv,
  createOrRegisterDynamicTableFromCsv,
  parseAndValidateProductsCsv,
  importProductsToDatabase,
  parseAndValidateSheetCsv,
  importSheetRecordsToDatabase,
  parseCsvBoolean,
};
