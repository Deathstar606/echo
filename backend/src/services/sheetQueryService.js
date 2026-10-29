const { query } = require('../../db');
const { getSchema, validateFilter, validateSort } = require('./sheetSchemaService');
const AppError = require('../utils/AppError');

const APPAREL_SIZE_KEYS = new Set(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL']);

/**
 * Normalizes a database row from the products table so numeric and boolean fields
 * are returned with consistent JavaScript types.
 *
 * @param {object} row
 * @returns {object}
 */
function normalizeProductRow(row) {
  if (!row || typeof row !== 'object') {
    return row;
  }
  const normalized = { ...row };
  if (normalized.price !== undefined && normalized.price !== null) {
    const numPrice = Number(normalized.price);
    if (Number.isFinite(numPrice)) {
      normalized.price = numPrice;
    }
  }
  if (normalized.discount !== undefined && normalized.discount !== null) {
    const numDiscount = Number(normalized.discount);
    if (Number.isFinite(numDiscount)) {
      normalized.discount = numDiscount;
    }
  }
  if (normalized.ordered !== undefined && normalized.ordered !== null) {
    const numOrdered = Number.parseInt(normalized.ordered, 10);
    if (Number.isFinite(numOrdered)) {
      normalized.ordered = numOrdered;
    }
  }
  if (normalized.best !== undefined && normalized.best !== null) {
    normalized.best = Boolean(normalized.best);
  }
  return normalized;
}

/**
 * Builds a safe, parameterized SQL query for reading products rows.
 *
 * @param {object} params
 * @param {string} [params.entity='products'] - Must resolve to 'products'
 * @param {string} params.businessId - UUID of the business
 * @param {Array<{ field: string, operator: string, value: any }>} [params.filters=[]]
 * @param {Array<{ field: string, direction?: 'asc' | 'desc' }>} [params.sort=[]]
 * @param {number | null} [params.limit=null]
 * @returns {{ sql: string, params: any[] }}
 */
function buildParameterizedSelectQuery({
  entity = 'products',
  businessId,
  filters = [],
  sort = [],
  limit = null,
}) {
  const schema = getSchema(entity);
  const sqlParams = [businessId];
  const whereClauses = [`business_id = $1`];

  for (const rawFilter of filters) {
    const validated = validateFilter(schema.entity, rawFilter);
    const { field, operator, value } = validated;
    const colDef = schema.columns[field];

    // Special handling for comma-separated color lists and JSON size maps
    if (field === 'color' && (operator === 'equals' || operator === 'contains')) {
      sqlParams.push(`%${String(value).trim()}%`);
      whereClauses.push(`${field} ILIKE $${sqlParams.length}`);
      continue;
    }

    if (field === 'size' && (operator === 'equals' || operator === 'contains')) {
      const trimmedVal = String(value).trim();
      if (APPAREL_SIZE_KEYS.has(trimmedVal.toUpperCase())) {
        sqlParams.push(`%"${trimmedVal.toUpperCase()}":%`);
      } else {
        sqlParams.push(`%${trimmedVal}%`);
      }
      whereClauses.push(`${field} ILIKE $${sqlParams.length}`);
      continue;
    }

    if (operator === 'equals') {
      if (colDef.type === 'string' && !colDef.allowedValues) {
        sqlParams.push(value);
        whereClauses.push(`LOWER(${field}) = LOWER($${sqlParams.length})`);
      } else {
        sqlParams.push(value);
        whereClauses.push(`${field} = $${sqlParams.length}`);
      }
    } else if (operator === 'not_equals') {
      if (colDef.type === 'string' && !colDef.allowedValues) {
        sqlParams.push(value);
        whereClauses.push(`LOWER(${field}) <> LOWER($${sqlParams.length})`);
      } else {
        sqlParams.push(value);
        whereClauses.push(`${field} <> $${sqlParams.length}`);
      }
    } else if (operator === 'greater_than') {
      sqlParams.push(value);
      whereClauses.push(`${field} > $${sqlParams.length}`);
    } else if (operator === 'greater_than_or_equal') {
      sqlParams.push(value);
      whereClauses.push(`${field} >= $${sqlParams.length}`);
    } else if (operator === 'less_than') {
      sqlParams.push(value);
      whereClauses.push(`${field} < $${sqlParams.length}`);
    } else if (operator === 'less_than_or_equal') {
      sqlParams.push(value);
      whereClauses.push(`${field} <= $${sqlParams.length}`);
    } else if (operator === 'contains') {
      sqlParams.push(`%${value}%`);
      whereClauses.push(`${field} ILIKE $${sqlParams.length}`);
    } else if (operator === 'not_contains') {
      sqlParams.push(`%${value}%`);
      whereClauses.push(`${field} NOT ILIKE $${sqlParams.length}`);
    } else if (operator === 'starts_with') {
      sqlParams.push(`${value}%`);
      whereClauses.push(`${field} ILIKE $${sqlParams.length}`);
    } else if (operator === 'ends_with') {
      sqlParams.push(`%${value}`);
      whereClauses.push(`${field} ILIKE $${sqlParams.length}`);
    } else if (operator === 'between') {
      sqlParams.push(value[0]);
      const p1 = sqlParams.length;
      sqlParams.push(value[1]);
      const p2 = sqlParams.length;
      whereClauses.push(`${field} BETWEEN $${p1} AND $${p2}`);
    } else if (operator === 'in') {
      sqlParams.push(value);
      whereClauses.push(`${field} = ANY($${sqlParams.length}::text[])`);
    } else if (operator === 'relative_days_ago') {
      sqlParams.push(value);
      whereClauses.push(`${field} >= (NOW() - ($${sqlParams.length}::integer * INTERVAL '1 day'))`);
    } else if (operator === 'this_month') {
      whereClauses.push(
        `${field} >= DATE_TRUNC('month', CURRENT_DATE) AND ${field} < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')`
      );
    }
  }

  // Sort clauses
  const validatedSort = validateSort(schema.entity, sort);
  const sortClauses = [];
  for (const s of validatedSort) {
    sortClauses.push(`${s.field} ${s.direction.toUpperCase()}`);
  }
  sortClauses.push('created_at DESC', 'id ASC');

  let sql = `
    SELECT *
    FROM ${schema.tableName}
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY ${sortClauses.join(', ')}
  `;

  if (limit && Number.isFinite(limit) && limit > 0) {
    sqlParams.push(limit);
    sql += ` LIMIT $${sqlParams.length}`;
  }

  return { sql: sql.trim(), params: sqlParams };
}

/**
 * Retrieves all product rows scoped to a business.
 *
 * @param {string} [entity='products']
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
async function getAllRows(entity = 'products', businessId) {
  const schema = getSchema(entity);
  const result = await query(
    `
      SELECT *
      FROM ${schema.tableName}
      WHERE business_id = $1
      ORDER BY created_at DESC, id ASC;
    `,
    [businessId]
  );
  return result.rows.map(normalizeProductRow);
}

/**
 * Executes a structured query against PostgreSQL.
 * If queryJson asks for clarification, returns immediately without running database queries.
 *
 * @param {object} params
 * @param {string} [params.entity='products']
 * @param {string} params.businessId
 * @param {object} params.queryJson - Interpreted query JSON
 * @returns {Promise<object>}
 */
async function executeSpreadsheetQuery({ entity = 'products', businessId, queryJson }) {
  if (!businessId) {
    throw new AppError('Business ID is required to execute a sheet query.', 400);
  }

  const schema = getSchema(entity);

  if (queryJson.status === 'clarification_needed') {
    return {
      status: 'clarification_needed',
      message: queryJson.message,
      entity: schema.entity,
      rows: [],
      count: 0,
    };
  }

  const { sql, params: sqlParams } = buildParameterizedSelectQuery({
    entity: schema.entity,
    businessId,
    filters: queryJson.filters || [],
    sort: queryJson.sort || [],
    limit: queryJson.limit || null,
  });

  const result = await query(sql, sqlParams);
  const rows = result.rows.map(normalizeProductRow);

  return {
    status: 'ok',
    interpretedQuery: {
      entity: schema.entity,
      operation: 'filter',
      filters: queryJson.filters || [],
      sort: queryJson.sort || [],
      limit: queryJson.limit || null,
    },
    rows,
    count: rows.length,
  };
}

module.exports = {
  normalizeProductRow,
  buildParameterizedSelectQuery,
  getAllRows,
  executeSpreadsheetQuery,
};
