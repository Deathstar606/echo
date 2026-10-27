const { parse } = require('csv-parse/sync');
const { withTransaction } = require('../../db');
const AppError = require('../utils/AppError');

const REQUIRED_COLUMNS = ['category', 'title', 'content'];

/**
 * Parses and validates a CSV buffer containing business context records.
 * Supports quoted fields containing commas and line breaks.
 *
 * @param {Buffer} fileBuffer - Raw CSV file buffer
 * @returns {Array<{ category: string, title: string, content: string }>}
 */
function parseAndValidateCsv(fileBuffer) {
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new AppError('Uploaded CSV file is empty.', 400);
  }

  const rawContent = fileBuffer.toString('utf8');
  if (!rawContent.trim()) {
    throw new AppError('Uploaded CSV file contains only whitespace.', 400);
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
    throw new AppError(
      `Malformed CSV file: ${err.message}`,
      400
    );
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AppError('Uploaded CSV file is empty.', 400);
  }

  // Validate header row
  const rawHeaders = rows[0].map((col) => String(col ?? '').trim().toLowerCase());
  const missingColumns = REQUIRED_COLUMNS.filter(
    (requiredCol) => !rawHeaders.includes(requiredCol)
  );

  if (missingColumns.length > 0) {
    throw new AppError(
      `Invalid CSV headers. Missing required column(s): ${missingColumns.join(', ')}. Required columns are: category, title, content.`,
      400
    );
  }

  // Check for duplicate or unknown headers
  const seenHeaders = new Set();
  for (const header of rawHeaders) {
    if (!header) {
      throw new AppError('Invalid CSV headers: empty column header detected.', 400);
    }
    if (!REQUIRED_COLUMNS.includes(header)) {
      throw new AppError(
        `Unexpected CSV column "${header}". Allowed columns are: category, title, content.`,
        400
      );
    }
    if (seenHeaders.has(header)) {
      throw new AppError(
        `Invalid CSV headers: duplicate column "${header}" detected.`,
        400
      );
    }
    seenHeaders.add(header);
  }

  if (rows.length < 2) {
    throw new AppError(
      'CSV file contains headers but no data rows to import.',
      400
    );
  }

  const categoryIndex = rawHeaders.indexOf('category');
  const titleIndex = rawHeaders.indexOf('title');
  const contentIndex = rawHeaders.indexOf('content');

  const records = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNumber = i + 1;

    const category = String(row[categoryIndex] ?? '').trim();
    const title = String(row[titleIndex] ?? '').trim();
    const content = String(row[contentIndex] ?? '').trim();

    // Skip rows where every cell is whitespace-only
    if (!category && !title && !content) {
      continue;
    }

    const missingFields = [];
    if (!category) missingFields.push('category');
    if (!title) missingFields.push('title');
    if (!content) missingFields.push('content');

    if (missingFields.length > 0) {
      throw new AppError(
        `Invalid CSV data at row ${rowNumber}: missing required value(s) for ${missingFields.join(', ')}.`,
        400
      );
    }

    if (category.length > 100) {
      throw new AppError(
        `Invalid CSV data at row ${rowNumber}: "category" exceeds maximum length of 100 characters.`,
        400
      );
    }

    if (title.length > 255) {
      throw new AppError(
        `Invalid CSV data at row ${rowNumber}: "title" exceeds maximum length of 255 characters.`,
        400
      );
    }

    records.push({
      category,
      title,
      content,
    });
  }

  if (records.length === 0) {
    throw new AppError(
      'CSV file contains no valid data rows to import.',
      400
    );
  }

  return records;
}

/**
 * Imports validated CSV records into PostgreSQL within a single transaction.
 * Deduplicates by (business_id, category, title), updating existing records on conflict.
 *
 * @param {string} businessId - UUID of the target business
 * @param {string} sourceFile - Original uploaded filename
 * @param {Array<{ category: string, title: string, content: string }>} records
 */
async function importContextRecords(businessId, sourceFile, records) {
  return withTransaction(async (client) => {
    let insertedCount = 0;
    let updatedCount = 0;
    const savedEntries = [];

    const upsertSql = `
      INSERT INTO context_entries (
        business_id,
        category,
        title,
        content,
        source_file,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (business_id, category, title)
      DO UPDATE SET
        content = EXCLUDED.content,
        source_file = EXCLUDED.source_file,
        updated_at = NOW()
      RETURNING
        id,
        business_id,
        category,
        title,
        content,
        source_file,
        created_at,
        updated_at,
        (xmax = 0) AS inserted;
    `;

    for (const record of records) {
      const result = await client.query(upsertSql, [
        businessId,
        record.category,
        record.title,
        record.content,
        sourceFile,
      ]);

      const row = result.rows[0];
      if (row.inserted) {
        insertedCount += 1;
      } else {
        updatedCount += 1;
      }

      savedEntries.push({
        id: row.id,
        businessId: row.business_id,
        category: row.category,
        title: row.title,
        sourceFile: row.source_file,
        updatedAt: row.updated_at,
      });
    }

    return {
      totalProcessed: records.length,
      insertedCount,
      updatedCount,
      entries: savedEntries,
    };
  });
}

module.exports = {
  parseAndValidateCsv,
  importContextRecords,
};
