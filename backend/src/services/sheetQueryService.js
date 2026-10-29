const { query } = require('../../db');
const {
  APPAREL_SIZE_KEYS,
  getSchema,
  validateFilter,
  validateSort,
} = require('./sheetSchemaService');
const { resolveNameFilters } = require('./productNameResolver');
const AppError = require('../utils/AppError');

/**
 * Computes the total stock across all sizes from a JSON size string.
 *
 * @param {string | object | null} sizeVal
 * @returns {number}
 */
function computeTotalStockFromSizeJson(sizeVal) {
  if (!sizeVal) return 0;
  let obj = sizeVal;
  if (typeof sizeVal === 'string') {
    const trimmed = sizeVal.trim();
    if (!trimmed.startsWith('{')) return 0;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return 0;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return 0;
  }
  let total = 0;
  for (const val of Object.values(obj)) {
    const num = Number(val);
    if (Number.isFinite(num)) {
      total += Math.round(num);
    }
  }
  return total;
}

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
 * Builds a numeric comparison SQL clause for a given SQL expression and operator.
 *
 * @param {string} sqlExpr
 * @param {string} operator
 * @param {any} value
 * @param {any[]} sqlParams
 * @returns {string}
 */
function buildNumericComparisonClause(sqlExpr, operator, value, sqlParams) {
  if (operator === 'equals') {
    sqlParams.push(value);
    return `${sqlExpr} = $${sqlParams.length}`;
  }
  if (operator === 'not_equals') {
    sqlParams.push(value);
    return `${sqlExpr} <> $${sqlParams.length}`;
  }
  if (operator === 'greater_than') {
    sqlParams.push(value);
    return `${sqlExpr} > $${sqlParams.length}`;
  }
  if (operator === 'greater_than_or_equal') {
    sqlParams.push(value);
    return `${sqlExpr} >= $${sqlParams.length}`;
  }
  if (operator === 'less_than') {
    sqlParams.push(value);
    return `${sqlExpr} < $${sqlParams.length}`;
  }
  if (operator === 'less_than_or_equal') {
    sqlParams.push(value);
    return `${sqlExpr} <= $${sqlParams.length}`;
  }
  if (operator === 'between') {
    sqlParams.push(value[0]);
    const p1 = sqlParams.length;
    sqlParams.push(value[1]);
    const p2 = sqlParams.length;
    return `${sqlExpr} BETWEEN $${p1} AND $${p2}`;
  }
  throw new AppError(`Unsupported numeric operator "${operator}".`, 400);
}

/**
 * Builds a safe, parameterized SQL query for reading products rows.
 * Supports AND/OR filter combinations, virtual `total_stock`, and nested `size.<KEY>` stock filters.
 *
 * @param {object} params
 * @param {string} [params.entity='products'] - Must resolve to 'products'
 * @param {string} params.businessId - UUID of the business
 * @param {Array<{ field: string, operator: string, value: any }>} [params.filters=[]]
 * @param {string} [params.filterLogic='AND'] - 'AND' | 'OR'
 * @param {Array<{ field: string, direction?: 'asc' | 'desc' }>} [params.sort=[]]
 * @param {number | null} [params.limit=null]
 * @returns {{ sql: string, params: any[] }}
 */
function buildParameterizedSelectQuery({
  entity = 'products',
  businessId,
  filters = [],
  filterLogic = 'AND',
  sort = [],
  limit = null,
}) {
  const schema = getSchema(entity);
  const sqlParams = [businessId];
  const filterClauses = [];

  const normalizedLogic =
    String(filterLogic || 'AND')
      .trim()
      .toUpperCase() === 'OR'
      ? 'OR'
      : 'AND';

  for (const rawFilter of filters) {
    const validated = validateFilter(schema.entity, rawFilter);
    const { field, operator, value, size_key: sizeKey } = validated;

    // 1. Nested size.<KEY> stock filter (e.g. size.M, size.XL)
    if (sizeKey && APPAREL_SIZE_KEYS.has(sizeKey)) {
      const sizeKeyExpr = `COALESCE((CASE WHEN size IS NOT NULL AND size LIKE '{%}' AND (size::jsonb ->> '${sizeKey}') ~ '^-?[0-9]+$' THEN (size::jsonb ->> '${sizeKey}')::integer ELSE 0 END), 0)`;
      filterClauses.push(
        buildNumericComparisonClause(sizeKeyExpr, operator, value, sqlParams)
      );
      continue;
    }

    // 2. Virtual total_stock filter across all sizes in the JSON `size` column
    if (field === 'total_stock') {
      const totalStockExpr = `COALESCE((SELECT SUM(CASE WHEN value ~ '^-?[0-9]+$' THEN value::integer ELSE 0 END) FROM jsonb_each_text(CASE WHEN size IS NOT NULL AND size LIKE '{%}' THEN size::jsonb ELSE '{}'::jsonb END)), 0)`;
      filterClauses.push(
        buildNumericComparisonClause(totalStockExpr, operator, value, sqlParams)
      );
      continue;
    }

    const colDef = schema.columns[field];

    // 3. Special handling for comma-separated color lists and JSON size maps
    if (field === 'color' && (operator === 'equals' || operator === 'contains')) {
      sqlParams.push(`%${String(value).trim()}%`);
      filterClauses.push(`${field} ILIKE $${sqlParams.length}`);
      continue;
    }

    if (field === 'size' && (operator === 'equals' || operator === 'contains')) {
      const trimmedVal = String(value).trim();
      if (APPAREL_SIZE_KEYS.has(trimmedVal.toUpperCase())) {
        sqlParams.push(`%"${trimmedVal.toUpperCase()}":%`);
      } else {
        sqlParams.push(`%${trimmedVal}%`);
      }
      filterClauses.push(`${field} ILIKE $${sqlParams.length}`);
      continue;
    }

    if (operator === 'equals') {
      if (colDef.type === 'string' && !colDef.allowedValues) {
        sqlParams.push(value);
        filterClauses.push(`LOWER(${field}) = LOWER($${sqlParams.length})`);
      } else {
        sqlParams.push(value);
        filterClauses.push(`${field} = $${sqlParams.length}`);
      }
    } else if (operator === 'not_equals') {
      if (colDef.type === 'string' && !colDef.allowedValues) {
        sqlParams.push(value);
        filterClauses.push(`LOWER(${field}) <> LOWER($${sqlParams.length})`);
      } else {
        sqlParams.push(value);
        filterClauses.push(`${field} <> $${sqlParams.length}`);
      }
    } else if (
      operator === 'greater_than' ||
      operator === 'greater_than_or_equal' ||
      operator === 'less_than' ||
      operator === 'less_than_or_equal' ||
      operator === 'between'
    ) {
      filterClauses.push(
        buildNumericComparisonClause(field, operator, value, sqlParams)
      );
    } else if (operator === 'contains') {
      sqlParams.push(`%${value}%`);
      filterClauses.push(`${field} ILIKE $${sqlParams.length}`);
    } else if (operator === 'not_contains') {
      sqlParams.push(`%${value}%`);
      filterClauses.push(`${field} NOT ILIKE $${sqlParams.length}`);
    } else if (operator === 'starts_with') {
      sqlParams.push(`${value}%`);
      filterClauses.push(`${field} ILIKE $${sqlParams.length}`);
    } else if (operator === 'ends_with') {
      sqlParams.push(`%${value}`);
      filterClauses.push(`${field} ILIKE $${sqlParams.length}`);
    } else if (operator === 'in') {
      sqlParams.push(value);
      const arrayType = colDef.type === 'uuid' ? 'uuid[]' : 'text[]';
      filterClauses.push(`${field} = ANY($${sqlParams.length}::${arrayType})`);
    } else if (operator === 'relative_days_ago') {
      sqlParams.push(value);
      filterClauses.push(
        `${field} >= (NOW() - ($${sqlParams.length}::integer * INTERVAL '1 day'))`
      );
    } else if (operator === 'this_month') {
      filterClauses.push(
        `${field} >= DATE_TRUNC('month', CURRENT_DATE) AND ${field} < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')`
      );
    }
  }

  let whereSql = 'business_id = $1';
  if (filterClauses.length === 1) {
    whereSql += ` AND ${filterClauses[0]}`;
  } else if (filterClauses.length > 1) {
    if (normalizedLogic === 'OR') {
      whereSql += ` AND (${filterClauses.join(' OR ')})`;
    } else {
      whereSql += ` AND ${filterClauses.join(' AND ')}`;
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
    WHERE ${whereSql}
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
async function executeSpreadsheetQuery({
  entity = 'products',
  businessId,
  queryJson,
}) {
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

  const filterLogic = queryJson.filter_logic || 'AND';

  // Resolve product-name filters against the live catalog (punctuation/case-insensitive,
  // partial-name aware) so arbitrary product names match reliably.
  const nameResolution = await resolveNameFilters({
    businessId,
    entity: schema.entity,
    filters: queryJson.filters || [],
  });
  if (nameResolution.status === 'clarification_needed') {
    return {
      status: 'clarification_needed',
      message: nameResolution.message,
      suggestions: nameResolution.suggestions,
      entity: schema.entity,
      rows: [],
      count: 0,
    };
  }
  const resolvedFilters = nameResolution.filters;

  const { sql, params: sqlParams } = buildParameterizedSelectQuery({
    entity: schema.entity,
    businessId,
    filters: resolvedFilters,
    filterLogic,
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
      filter_logic: filterLogic,
      filters: resolvedFilters,
      sort: queryJson.sort || [],
      limit: queryJson.limit || null,
    },
    name_resolutions: nameResolution.resolutions,
    rows,
    count: rows.length,
  };
}

module.exports = {
  computeTotalStockFromSizeJson,
  normalizeProductRow,
  buildParameterizedSelectQuery,
  getAllRows,
  executeSpreadsheetQuery,
};
