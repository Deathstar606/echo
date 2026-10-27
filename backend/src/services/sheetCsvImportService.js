const { parse } = require('csv-parse/sync');
const path = require('node:path');
const { withTransaction } = require('../../db');
const AppError = require('../utils/AppError');

/**
 * Parses and validates a products CSV buffer.
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

  const requiredCols = ['name', 'price', 'stock'];
  const missing = requiredCols.filter((c) => !rawHeaders.includes(c));
  if (missing.length > 0) {
    throw new AppError(
      `Invalid products CSV headers. Missing required column(s): ${missing.join(', ')}. Required columns: name, price, stock.`,
      400
    );
  }

  const nameIdx = rawHeaders.indexOf('name');
  const descIdx = rawHeaders.indexOf('description');
  const priceIdx = rawHeaders.indexOf('price');
  const stockIdx = rawHeaders.indexOf('stock');
  const catIdx = rawHeaders.indexOf('category');
  const sizeIdx = rawHeaders.indexOf('size');
  const colorIdx = rawHeaders.indexOf('color');
  const createdIdx = rawHeaders.indexOf('created_at');

  const validRecords = [];
  const rejectedRows = [];
  let totalRows = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNum = i + 1;

    const rawName = String(row[nameIdx] ?? '').trim();
    const rawPrice = String(row[priceIdx] ?? '').trim();
    const rawStock = String(row[stockIdx] ?? '').trim();
    const rawDesc = descIdx !== -1 ? String(row[descIdx] ?? '').trim() : '';
    const rawCat = catIdx !== -1 ? String(row[catIdx] ?? '').trim() : '';
    const rawSize = sizeIdx !== -1 ? String(row[sizeIdx] ?? '').trim() : '';
    const rawColor = colorIdx !== -1 ? String(row[colorIdx] ?? '').trim() : '';
    const rawCreated = createdIdx !== -1 ? String(row[createdIdx] ?? '').trim() : '';

    // Skip entirely empty lines
    if (!rawName && !rawPrice && !rawStock && !rawDesc) {
      continue;
    }

    totalRows += 1;
    const rowErrors = [];

    if (!rawName) {
      rowErrors.push('missing required "name"');
    }

    const priceNum = Number(rawPrice);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      rowErrors.push(`invalid "price" (${rawPrice}), must be non-negative number`);
    }

    const stockNum = Number(rawStock);
    if (!Number.isFinite(stockNum) || stockNum < 0) {
      rowErrors.push(`invalid "stock" (${rawStock}), must be non-negative integer`);
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
      description: rawDesc || null,
      price: priceNum,
      stock: Math.round(stockNum),
      category: rawCat || null,
      size: rawSize || null,
      color: rawColor || null,
      created_at: parsedCreatedAt,
    });
  }

  if (totalRows === 0) {
    throw new AppError('CSV file contains headers but no data rows to import.', 400);
  }

  return { validRecords, rejectedRows, totalRows };
}

/**
 * Parses and validates a services CSV buffer.
 *
 * @param {Buffer} fileBuffer
 * @returns {{ validRecords: any[], rejectedRows: any[], totalRows: number }}
 */
function parseAndValidateServicesCsv(fileBuffer) {
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

  const requiredCols = ['name', 'rate', 'availability'];
  const missing = requiredCols.filter((c) => !rawHeaders.includes(c));
  if (missing.length > 0) {
    throw new AppError(
      `Invalid services CSV headers. Missing required column(s): ${missing.join(', ')}. Required columns: name, rate, availability.`,
      400
    );
  }

  const nameIdx = rawHeaders.indexOf('name');
  const descIdx = rawHeaders.indexOf('description');
  const rateIdx = rawHeaders.indexOf('rate');
  const availIdx = rawHeaders.indexOf('availability');
  const sizeIdx = rawHeaders.indexOf('size');
  const availFromIdx = rawHeaders.indexOf('available_from');
  const createdIdx = rawHeaders.indexOf('created_at');

  const validRecords = [];
  const rejectedRows = [];
  let totalRows = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNum = i + 1;

    const rawName = String(row[nameIdx] ?? '').trim();
    const rawRate = String(row[rateIdx] ?? '').trim();
    const rawAvail = String(row[availIdx] ?? '').trim().toLowerCase();
    const rawDesc = descIdx !== -1 ? String(row[descIdx] ?? '').trim() : '';
    const rawSize = sizeIdx !== -1 ? String(row[sizeIdx] ?? '').trim() : '';
    const rawAvailFrom = availFromIdx !== -1 ? String(row[availFromIdx] ?? '').trim() : '';
    const rawCreated = createdIdx !== -1 ? String(row[createdIdx] ?? '').trim() : '';

    if (!rawName && !rawRate && !rawAvail && !rawDesc) {
      continue;
    }

    totalRows += 1;
    const rowErrors = [];

    if (!rawName) {
      rowErrors.push('missing required "name"');
    }

    const rateNum = Number(rawRate);
    if (!Number.isFinite(rateNum) || rateNum < 0) {
      rowErrors.push(`invalid "rate" (${rawRate}), must be non-negative number`);
    }

    let normalizedAvail = rawAvail;
    if (rawAvail === 'true' || rawAvail === 'in_stock' || rawAvail === 'yes') normalizedAvail = 'available';
    if (rawAvail === 'false' || rawAvail === 'out_of_stock' || rawAvail === 'no') normalizedAvail = 'unavailable';

    if (!['available', 'unavailable'].includes(normalizedAvail)) {
      rowErrors.push(`invalid "availability" (${rawAvail}), must be "available" or "unavailable"`);
    }

    let parsedAvailFrom = null;
    if (rawAvailFrom) {
      const d = new Date(rawAvailFrom);
      if (Number.isNaN(d.getTime())) {
        rowErrors.push(`invalid "available_from" date format (${rawAvailFrom})`);
      } else {
        parsedAvailFrom = d.toISOString().slice(0, 10);
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
      description: rawDesc || null,
      rate: rateNum,
      availability: normalizedAvail,
      size: rawSize || null,
      available_from: parsedAvailFrom,
      created_at: parsedCreatedAt,
    });
  }

  if (totalRows === 0) {
    throw new AppError('CSV file contains headers but no data rows to import.', 400);
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
    await client.query('DELETE FROM products WHERE business_id = $1;', [businessId]);

    let inserted = 0;
    const insertSql = `
      INSERT INTO products (
        business_id,
        name,
        description,
        price,
        stock,
        category,
        size,
        color,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()), NOW())
      RETURNING id;
    `;

    for (const rec of validRecords) {
      await client.query(insertSql, [
        businessId,
        rec.name,
        rec.description,
        rec.price,
        rec.stock,
        rec.category,
        rec.size,
        rec.color,
        rec.created_at,
      ]);
      inserted += 1;
    }

    return inserted;
  });
}

/**
 * Imports services CSV into PostgreSQL for a business.
 * Discards existing services for this business and stores the new records cleanly inside a transaction.
 *
 * @param {string} businessId
 * @param {Array<object>} validRecords
 * @returns {Promise<number>} count of imported records
 */
async function importServicesToDatabase(businessId, validRecords) {
  return withTransaction(async (client) => {
    // Discard existing services for this business
    await client.query('DELETE FROM services WHERE business_id = $1;', [businessId]);

    let inserted = 0;
    const insertSql = `
      INSERT INTO services (
        business_id,
        name,
        description,
        rate,
        availability,
        size,
        available_from,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()), NOW())
      RETURNING id;
    `;

    for (const rec of validRecords) {
      await client.query(insertSql, [
        businessId,
        rec.name,
        rec.description,
        rec.rate,
        rec.availability,
        rec.size,
        rec.available_from,
        rec.created_at,
      ]);
      inserted += 1;
    }

    return inserted;
  });
}

module.exports = {
  parseAndValidateProductsCsv,
  parseAndValidateServicesCsv,
  importProductsToDatabase,
  importServicesToDatabase,
};
