const { parse } = require('csv-parse/sync');
const { withTransaction } = require('../../db');
const AppError = require('../utils/AppError');

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
 * @returns {{ validRecords: any[], rejectedRows: any[], totalRows: number }}
 */
function parseAndValidateProductsCsv(fileBuffer) {
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
 * Discards existing products for this business and stores the new records cleanly inside a transaction.
 *
 * @param {string} businessId
 * @param {Array<object>} validRecords
 * @returns {Promise<number>} count of imported records
 */
async function importProductsToDatabase(businessId, validRecords) {
  return withTransaction(async (client) => {
    // Discard existing products for this business so the new copy is the only copy
    await client.query('DELETE FROM products WHERE business_id = $1;', [
      businessId,
    ]);

    let inserted = 0;
    const insertSql = `
      INSERT INTO products (
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
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, NOW()), NOW())
      RETURNING id;
    `;

    for (const rec of validRecords) {
      await client.query(insertSql, [
        businessId,
        rec.name,
        rec.category,
        rec.description,
        Boolean(rec.best),
        rec.color,
        rec.discount ?? 0,
        rec.ordered ?? 0,
        rec.images,
        rec.size,
        rec.price,
        rec.created_at || null,
      ]);
      inserted += 1;
    }

    return inserted;
  });
}

module.exports = {
  parseAndValidateProductsCsv,
  importProductsToDatabase,
};
