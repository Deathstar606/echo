const crypto = require('node:crypto');
const { withTransaction } = require('../../db');
const { normalizeEntityName } = require('./sheetSchemaService');
const { generateAiSheetSampleData } = require('./geminiService');
const AppError = require('../utils/AppError');

/**
 * Validates and normalizes an array of candidate generated rows against the canonical
 * schema for 'products' or 'services'.
 *
 * @param {string} rawEntity - 'products' | 'services'
 * @param {Array<object>} rawRows
 * @returns {{ validRows: Array<object>, errors: Array<{ index: number, reason: string }> }}
 */
function validateAndNormalizeGeneratedRows(rawEntity, rawRows) {
  const entity = normalizeEntityName(rawEntity);
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new AppError(
      `Expected a non-empty array of ${entity} records to validate.`,
      400
    );
  }

  const validRows = [];
  const errors = [];

  rawRows.forEach((row, idx) => {
    if (!row || typeof row !== 'object') {
      errors.push({ index: idx + 1, reason: 'Row must be a JSON object.' });
      return;
    }

    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) {
      errors.push({
        index: idx + 1,
        reason: 'Missing required "name" field.',
      });
      return;
    }

    const description =
      row.description !== undefined &&
      row.description !== null &&
      String(row.description).trim()
        ? String(row.description).trim()
        : null;

    const size =
      row.size !== undefined && row.size !== null && String(row.size).trim()
        ? String(row.size).trim()
        : null;

    if (entity === 'products') {
      const priceNum = Number(row.price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        errors.push({
          index: idx + 1,
          reason: `Invalid "price" (${row.price}): must be a non-negative number.`,
        });
        return;
      }

      const stockNum = Number(row.stock);
      if (
        !Number.isFinite(stockNum) ||
        !Number.isInteger(Math.round(stockNum)) ||
        stockNum < 0
      ) {
        errors.push({
          index: idx + 1,
          reason: `Invalid "stock" (${row.stock}): must be a non-negative integer.`,
        });
        return;
      }

      const category =
        row.category !== undefined &&
        row.category !== null &&
        String(row.category).trim()
          ? String(row.category).trim()
          : null;

      const color =
        row.color !== undefined &&
        row.color !== null &&
        String(row.color).trim()
          ? String(row.color).trim()
          : null;

      validRows.push({
        id: row.id || `draft-${crypto.randomUUID()}`,
        name,
        description,
        price: Number(priceNum.toFixed(2)),
        stock: Math.round(stockNum),
        category,
        size,
        color,
      });
    } else {
      const rateNum = Number(row.rate);
      if (!Number.isFinite(rateNum) || rateNum < 0) {
        errors.push({
          index: idx + 1,
          reason: `Invalid "rate" (${row.rate}): must be a non-negative number.`,
        });
        return;
      }

      const rawAvail = String(row.availability || 'available')
        .trim()
        .toLowerCase();
      if (rawAvail !== 'available' && rawAvail !== 'unavailable') {
        errors.push({
          index: idx + 1,
          reason: `Invalid "availability" (${row.availability}): must be "available" or "unavailable".`,
        });
        return;
      }

      let availableFrom = null;
      if (
        row.available_from !== undefined &&
        row.available_from !== null &&
        String(row.available_from).trim()
      ) {
        const dateStr = String(row.available_from).trim().slice(0, 10);
        const parsedDate = new Date(dateStr);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) ||
          Number.isNaN(parsedDate.getTime())
        ) {
          errors.push({
            index: idx + 1,
            reason: `Invalid "available_from" (${row.available_from}): must be YYYY-MM-DD.`,
          });
          return;
        }
        availableFrom = dateStr;
      }

      validRows.push({
        id: row.id || `draft-${crypto.randomUUID()}`,
        name,
        description,
        rate: Number(rateNum.toFixed(2)),
        availability: rawAvail,
        size,
        available_from: availableFrom,
      });
    }
  });

  return { validRows, errors };
}

/**
 * Builds the Gemini prompt for generating realistic sample sheet records.
 *
 * @param {object} params
 * @param {string} params.entity - 'products' | 'services'
 * @param {string} params.businessName
 * @param {number} params.count
 * @param {string} [params.customPrompt]
 * @returns {string}
 */
function buildSheetSampleDataPrompt({
  entity,
  businessName,
  count,
  customPrompt = '',
}) {
  const safeCount = Math.min(Math.max(Number(count) || 5, 1), 15);
  const customNote = customPrompt
    ? `\nAdditional theme/direction requested by user: ${customPrompt.trim()}`
    : '';

  if (entity === 'products') {
    return `You are a data generator for "${businessName}".
Generate exactly ${safeCount} realistic, internally consistent sample product records.${customNote}

Each record MUST adhere strictly to this schema:
- name (string, required, non-empty product title)
- description (string, concise realistic description)
- price (number >= 0, e.g. 49.99)
- stock (integer >= 0, include a mix of stocked items and 1 out-of-stock item with 0)
- category (string, e.g. "Outerwear", "Footwear", "Camping", "Apparel", "Accessories", "Tools")
- size (string or null, e.g. "S", "M", "L", "XL", "One Size")
- color (string or null, e.g. "Black", "Blue", "Red", "Olive", "Grey", "Silver")

Return ONLY valid JSON with this structure:
{
  "rows": [
    {
      "name": "...",
      "description": "...",
      "price": 79.99,
      "stock": 15,
      "category": "Outerwear",
      "size": "L",
      "color": "Olive"
    }
  ]
}`;
  }

  return `You are a data generator for "${businessName}".
Generate exactly ${safeCount} realistic, internally consistent sample service records.${customNote}

Each record MUST adhere strictly to this schema:
- name (string, required, non-empty service title)
- description (string, concise realistic service description)
- rate (number >= 0, e.g. 125.00)
- availability (string, MUST be either "available" or "unavailable")
- size (string or null, e.g. "Small", "Medium", "Large")
- available_from (string date in YYYY-MM-DD format, e.g. "2026-11-10", or null)

Return ONLY valid JSON with this structure:
{
  "rows": [
    {
      "name": "...",
      "description": "...",
      "rate": 135.00,
      "availability": "available",
      "size": "Medium",
      "available_from": "2026-11-12"
    }
  ]
}`;
}

/**
 * Generates validated sample rows for 'products' or 'services' without saving them to PostgreSQL.
 *
 * @param {object} params
 * @param {string} params.entity - 'products' | 'services'
 * @param {{ id: string, name: string }} params.business
 * @param {number} [params.count=5]
 * @param {string} [params.prompt='']
 */
async function generateSampleSheetDraft({
  entity: rawEntity,
  business,
  count = 5,
  prompt = '',
}) {
  const entity = normalizeEntityName(rawEntity);
  const safeCount = Math.min(Math.max(Number(count) || 5, 1), 15);

  const promptText = buildSheetSampleDataPrompt({
    entity,
    businessName: business.name,
    count: safeCount,
    customPrompt: prompt,
  });

  const rawResult = await generateAiSheetSampleData(promptText);
  const candidateRows = Array.isArray(rawResult)
    ? rawResult
    : Array.isArray(rawResult?.rows)
      ? rawResult.rows
      : [];

  const { validRows, errors } = validateAndNormalizeGeneratedRows(
    entity,
    candidateRows
  );

  if (validRows.length === 0) {
    throw new AppError(
      `Generated sample ${entity} data failed schema validation: ${errors.map((e) => e.reason).join('; ')}`,
      502
    );
  }

  return {
    status: 'draft_preview',
    entity,
    business_id: business.id,
    is_unsaved_draft: true,
    count: validRows.length,
    rows: validRows,
    validation_errors: errors,
  };
}

/**
 * Persists validated generated rows to PostgreSQL for the specified business.
 * Requires explicit confirmation (confirm === true).
 * Supports mode = 'append' (adds to existing rows) or mode = 'replace' (replaces existing rows for the business).
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.entity
 * @param {Array<object>} params.rows
 * @param {'append' | 'replace'} [params.mode='append']
 * @param {boolean} [params.confirm=false]
 */
async function saveGeneratedSheetRows({
  businessId,
  entity: rawEntity,
  rows,
  mode = 'append',
  confirm = false,
}) {
  if (confirm !== true) {
    throw new AppError(
      'Explicit confirmation ("confirm": true) is required before saving generated sheet data.',
      400
    );
  }

  const normalizedMode = String(mode || 'append')
    .trim()
    .toLowerCase();
  if (normalizedMode !== 'append' && normalizedMode !== 'replace') {
    throw new AppError(
      'Invalid save mode. Expected "append" or "replace".',
      400
    );
  }

  const entity = normalizeEntityName(rawEntity);
  const { validRows, errors } = validateAndNormalizeGeneratedRows(entity, rows);

  if (errors.length > 0) {
    throw new AppError(
      `Cannot save generated ${entity} data because ${errors.length} row(s) failed schema validation: ${errors.map((e) => `Row ${e.index}: ${e.reason}`).join('; ')}`,
      400
    );
  }

  const insertedRows = await withTransaction(async (client) => {
    if (normalizedMode === 'replace') {
      if (entity === 'products') {
        await client.query('DELETE FROM products WHERE business_id = $1;', [
          businessId,
        ]);
      } else {
        await client.query('DELETE FROM services WHERE business_id = $1;', [
          businessId,
        ]);
      }
    }

    const saved = [];
    for (const r of validRows) {
      if (entity === 'products') {
        const res = await client.query(
          `
            INSERT INTO products (
              business_id, name, description, price, stock, category, size, color, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()), NOW())
            RETURNING *;
          `,
          [
            businessId,
            r.name,
            r.description,
            r.price,
            r.stock,
            r.category,
            r.size,
            r.color,
            null,
          ]
        );
        saved.push(res.rows[0]);
      } else {
        const res = await client.query(
          `
            INSERT INTO services (
              business_id, name, description, rate, availability, size, available_from, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()), NOW())
            RETURNING *;
          `,
          [
            businessId,
            r.name,
            r.description,
            r.rate,
            r.availability,
            r.size,
            r.available_from,
            null,
          ]
        );
        saved.push(res.rows[0]);
      }
    }

    return saved;
  });

  return {
    status: 'saved',
    entity,
    business_id: businessId,
    mode: normalizedMode,
    saved_count: insertedRows.length,
    rows: insertedRows,
  };
}

module.exports = {
  validateAndNormalizeGeneratedRows,
  buildSheetSampleDataPrompt,
  generateSampleSheetDraft,
  saveGeneratedSheetRows,
};
