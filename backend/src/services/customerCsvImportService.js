const { parse } = require('csv-parse/sync');
const { withTransaction } = require('../../db');
const AppError = require('../utils/AppError');
const { normalizeEmail, isValidEmail } = require('../middleware/validate');

const REQUIRED_CUSTOMER_COLUMNS = ['customer_name', 'email'];
const ALLOWED_CUSTOMER_COLUMNS = new Set([
  'customer_name',
  'email',
  'external_customer_id',
]);

/**
 * Parses and validates a customer CSV buffer.
 * Validates headers and evaluates each row, separating valid rows from rejected rows
 * with detailed row-level error messages.
 *
 * @param {Buffer} fileBuffer
 * @returns {{ validRecords: Array<{ row: number, customer_name: string, email: string, external_customer_id: string | null }>, rejectedRows: Array<{ row: number, customer_name: string, email: string, error: string }>, totalRows: number }}
 */
function parseAndValidateCustomerCsv(fileBuffer) {
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
    throw new AppError(`Malformed CSV file: ${err.message}`, 400);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AppError('Uploaded CSV file is empty.', 400);
  }

  const rawHeaders = rows[0].map((col) =>
    String(col ?? '')
      .trim()
      .toLowerCase()
  );

  const missingColumns = REQUIRED_CUSTOMER_COLUMNS.filter(
    (requiredCol) => !rawHeaders.includes(requiredCol)
  );

  if (missingColumns.length > 0) {
    throw new AppError(
      `Invalid CSV headers. Missing required column(s): ${missingColumns.join(', ')}. Required columns are: customer_name, email.`,
      400
    );
  }

  const seenHeaders = new Set();
  for (const header of rawHeaders) {
    if (!header) {
      throw new AppError(
        'Invalid CSV headers: empty column header detected.',
        400
      );
    }
    if (!ALLOWED_CUSTOMER_COLUMNS.has(header)) {
      throw new AppError(
        `Unexpected CSV column "${header}". Allowed columns are: customer_name, email, external_customer_id.`,
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
      'CSV file contains headers but no customer rows to import.',
      400
    );
  }

  const nameIndex = rawHeaders.indexOf('customer_name');
  const emailIndex = rawHeaders.indexOf('email');
  const externalIdIndex = rawHeaders.indexOf('external_customer_id');

  const validRecords = [];
  const rejectedRows = [];
  let totalRows = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNumber = i + 1;

    const rawName = String(row[nameIndex] ?? '').trim();
    const rawEmail = String(row[emailIndex] ?? '').trim();
    const rawExtId =
      externalIdIndex !== -1 ? String(row[externalIdIndex] ?? '').trim() : '';

    // Skip rows where every cell is whitespace-only
    if (!rawName && !rawEmail && !rawExtId) {
      continue;
    }

    totalRows += 1;
    const rowErrors = [];

    if (!rawName) {
      rowErrors.push('missing required "customer_name"');
    } else if (rawName.length > 255) {
      rowErrors.push('"customer_name" exceeds 255 characters');
    }

    const normalizedEmail = normalizeEmail(rawEmail);
    if (!normalizedEmail) {
      rowErrors.push('missing required "email"');
    } else if (!isValidEmail(normalizedEmail)) {
      rowErrors.push(`invalid email format "${rawEmail}"`);
    }

    if (rawExtId && rawExtId.length > 255) {
      rowErrors.push('"external_customer_id" exceeds 255 characters');
    }

    if (rowErrors.length > 0) {
      rejectedRows.push({
        row: rowNumber,
        customer_name: rawName,
        email: rawEmail,
        error: `Row ${rowNumber}: ${rowErrors.join('; ')}.`,
      });
      continue;
    }

    validRecords.push({
      row: rowNumber,
      customer_name: rawName,
      email: normalizedEmail,
      external_customer_id: rawExtId || null,
    });
  }

  if (totalRows === 0) {
    throw new AppError(
      'CSV file contains no customer data rows to import.',
      400
    );
  }

  return {
    validRecords,
    rejectedRows,
    totalRows,
  };
}

/**
 * Imports and updates validated customer CSV records into PostgreSQL under the target businessId
 * inside a transaction. Normalizes emails and updates existing records on conflict.
 *
 * @param {string} businessId
 * @param {Array<{ customer_name: string, email: string, external_customer_id: string | null }>} validRecords
 */
async function upsertCustomerCsvRecords(businessId, validRecords) {
  if (!Array.isArray(validRecords) || validRecords.length === 0) {
    return {
      importedCount: 0,
      updatedCount: 0,
      customers: [],
    };
  }

  return withTransaction(async (client) => {
    let importedCount = 0;
    let updatedCount = 0;
    const savedCustomers = [];

    const upsertSql = `
      INSERT INTO customers (
        business_id,
        customer_name,
        email,
        external_customer_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (business_id, email)
      DO UPDATE SET
        customer_name = EXCLUDED.customer_name,
        external_customer_id = COALESCE(EXCLUDED.external_customer_id, customers.external_customer_id),
        updated_at = NOW()
      RETURNING
        id,
        business_id,
        customer_name,
        email,
        external_customer_id,
        created_at,
        updated_at,
        (xmax = 0) AS inserted;
    `;

    for (const record of validRecords) {
      const normalizedEmail = normalizeEmail(record.email);
      const result = await client.query(upsertSql, [
        businessId,
        record.customer_name.trim(),
        normalizedEmail,
        record.external_customer_id,
      ]);

      const row = result.rows[0];
      if (row.inserted) {
        importedCount += 1;
      } else {
        updatedCount += 1;
      }

      savedCustomers.push({
        id: row.id,
        business_id: row.business_id,
        customer_name: row.customer_name,
        email: row.email,
        external_customer_id: row.external_customer_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }

    return {
      importedCount,
      updatedCount,
      customers: savedCustomers,
    };
  });
}

module.exports = {
  parseAndValidateCustomerCsv,
  upsertCustomerCsvRecords,
};
