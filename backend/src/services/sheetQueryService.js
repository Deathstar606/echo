const { query } = require('../../db');
const {
  getSchema,
  discoverTableSchema,
  ensureTableExists,
  findColumnDef,
  quoteIdentifier,
  validateFilter,
  validateSort,
} = require('./sheetSchemaService');
const { resolveNameFilters } = require('./catalogNameResolver');
const {
  normalizeConversationHistory,
  getLatestActiveContext,
  hasFollowUpReference,
  hasExplicitScopeReset,
  resolveIdentifierFilterForIds,
} = require('../utils/conversationHistory');
const AppError = require('../utils/AppError');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Normalizes a database row from any inventory table so numeric and boolean fields
 * are returned with consistent JavaScript types according to the table's schema.
 *
 * @param {object} row
 * @param {string | object} [entityOrSchema='products']
 * @returns {object}
 */
function normalizeProductRow(row, entityOrSchema = 'products') {
  if (!row || typeof row !== 'object') {
    return row;
  }
  const normalized = { ...row };
  let schema = null;
  try {
    schema = getSchema(entityOrSchema);
  } catch {
    schema = null;
  }

  if (schema && schema.columns) {
    const allowedExactKeys = new Set();
    for (const [colKey, colDef] of Object.entries(schema.columns)) {
      if (colDef && colDef.exactName) {
        allowedExactKeys.add(colDef.exactName.toLowerCase());
      }
      allowedExactKeys.add(colKey.toLowerCase());
    }
    // Always preserve system primary/metadata columns
    allowedExactKeys.add('id');
    allowedExactKeys.add('business_id');
    allowedExactKeys.add('workspace_id');
    allowedExactKeys.add('user_id');
    allowedExactKeys.add('workspace_document_id');
    allowedExactKeys.add('_google_row_index');
    allowedExactKeys.add('created_at');
    allowedExactKeys.add('updated_at');

    // Strip any column from normalized that is not in the schema (prevents imaginary or leftover columns from leaking)
    for (const key of Object.keys(normalized)) {
      if (!allowedExactKeys.has(key.toLowerCase())) {
        delete normalized[key];
      }
    }

    for (const [colKey, colDef] of Object.entries(schema.columns)) {
      const exactCol = colDef.exactName || colKey;
      const targetKey = row[exactCol] !== undefined ? exactCol : (row[colKey] !== undefined ? colKey : null);
      if (!targetKey) continue;

      if (colDef.type === 'number') {
        const num = Number(normalized[targetKey]);
        if (Number.isFinite(num)) normalized[targetKey] = num;
      } else if (colDef.type === 'integer') {
        const num = Number(normalized[targetKey]);
        if (Number.isFinite(num)) normalized[targetKey] = Math.round(num);
      } else if (colDef.type === 'boolean') {
        if (normalized[targetKey] !== undefined && normalized[targetKey] !== null) {
          normalized[targetKey] = Boolean(normalized[targetKey]);
        }
      }
    }
  }

  // Fallback / standard conversions for products fields
  if (normalized.price !== undefined && normalized.price !== null) {
    const num = Number(normalized.price);
    if (Number.isFinite(num)) normalized.price = num;
  }
  if (normalized.discount !== undefined && normalized.discount !== null) {
    const num = Number(normalized.discount);
    if (Number.isFinite(num)) normalized.discount = num;
  }
  if (normalized.ordered !== undefined && normalized.ordered !== null) {
    const num = Number.parseInt(normalized.ordered, 10);
    if (Number.isFinite(num)) normalized.ordered = num;
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
 * Builds a safe, parameterized SQL query for reading inventory rows across arbitrary schemas.
 *
 * @param {object} params
 * @param {string | object} [params.entity='products'] - Entity name or schema object
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
    const validated = validateFilter(schema, rawFilter);
    const {
      field,
      operator,
      value,
      nested_field: nestedField,
      nested_key: nestedKey,
    } = validated;

    if (nestedField && nestedKey) {
      const nestedColumn = findColumnDef(schema, nestedField);
      if (!nestedColumn) {
        throw new AppError(`Unknown nested map column "${nestedField}".`, 400);
      }
      const nestedColumnSql = quoteIdentifier(nestedColumn.exactName);
      sqlParams.push(nestedKey);
      const keyParam = `$${sqlParams.length}`;
      const nestedValueExpr = `(${nestedColumnSql}::jsonb ->> ${keyParam})`;
      const sizeKeyExpr = `COALESCE((CASE WHEN ${nestedColumnSql} IS NOT NULL AND ${nestedColumnSql}::text LIKE '{%}' AND ${nestedValueExpr} ~ '^-?[0-9]+([.][0-9]+)?$' THEN ${nestedValueExpr}::numeric ELSE 0 END), 0)`;
      filterClauses.push(
        buildNumericComparisonClause(sizeKeyExpr, operator, value, sqlParams)
      );
      continue;
    }

    // 2. Virtual total_stock filter across all sizes in the JSON `size` column
    if (field === 'total_stock') {
      const sizeColumn = findColumnDef(schema, 'size');
      const sizeSql = quoteIdentifier(sizeColumn ? sizeColumn.exactName : 'size');
      const totalStockExpr = `COALESCE((SELECT SUM(CASE WHEN value ~ '^-?[0-9]+([.][0-9]+)?$' THEN value::numeric ELSE 0 END) FROM jsonb_each_text(CASE WHEN ${sizeSql} IS NOT NULL AND ${sizeSql}::text LIKE '{%}' THEN ${sizeSql}::jsonb ELSE '{}'::jsonb END)), 0)`;
      filterClauses.push(
        buildNumericComparisonClause(totalStockExpr, operator, value, sqlParams)
      );
      continue;
    }

    const colMatch = findColumnDef(schema, field);
    const colDef = colMatch ? colMatch.colDef : { type: 'string' };
    const exactCol = colMatch ? colMatch.exactName : field;
    const colSql = quoteIdentifier(exactCol);

    // 3. Special handling for comma-separated color lists and JSON size maps
    if (field.toLowerCase() === 'color' && (operator === 'equals' || operator === 'contains')) {
      sqlParams.push(`%${String(value).trim()}%`);
      filterClauses.push(`${colSql} ILIKE $${sqlParams.length}`);
      continue;
    }

    if (colDef.nestedMap && (operator === 'equals' || operator === 'contains')) {
      const trimmedVal = String(value).trim();
      sqlParams.push(`%${trimmedVal}%`);
      filterClauses.push(`${colSql}::text ILIKE $${sqlParams.length}`);
      continue;
    }

    if (operator === 'equals') {
      if (colDef.type === 'string') {
        sqlParams.push(value);
        filterClauses.push(`LOWER(${colSql}) = LOWER($${sqlParams.length})`);
      } else if (colDef.type === 'date') {
        sqlParams.push(value);
        filterClauses.push(`${colSql} = $${sqlParams.length}::date`);
      } else if (colDef.type === 'uuid') {
        const strVal = String(value ?? '').trim();
        if (UUID_REGEX.test(strVal)) {
          sqlParams.push(strVal);
          filterClauses.push(`${colSql} = $${sqlParams.length}::uuid`);
        } else {
          // Fallback to text cast so PostgreSQL does not abort with 22P02
          sqlParams.push(strVal);
          filterClauses.push(`CAST(${colSql} AS TEXT) = $${sqlParams.length}`);
        }
      } else {
        sqlParams.push(value);
        filterClauses.push(`${colSql} = $${sqlParams.length}`);
      }
    } else if (operator === 'not_equals') {
      if (colDef.type === 'string') {
        sqlParams.push(value);
        filterClauses.push(`LOWER(${colSql}) <> LOWER($${sqlParams.length})`);
      } else if (colDef.type === 'date') {
        sqlParams.push(value);
        filterClauses.push(`${colSql} <> $${sqlParams.length}::date`);
      } else if (colDef.type === 'uuid') {
        const strVal = String(value ?? '').trim();
        if (UUID_REGEX.test(strVal)) {
          sqlParams.push(strVal);
          filterClauses.push(`${colSql} <> $${sqlParams.length}::uuid`);
        } else {
          // Fallback to text cast so PostgreSQL does not abort with 22P02
          sqlParams.push(strVal);
          filterClauses.push(`CAST(${colSql} AS TEXT) <> $${sqlParams.length}`);
        }
      } else {
        sqlParams.push(value);
        filterClauses.push(`${colSql} <> $${sqlParams.length}`);
      }
    } else if (
      operator === 'greater_than' ||
      operator === 'greater_than_or_equal' ||
      operator === 'less_than' ||
      operator === 'less_than_or_equal' ||
      operator === 'between'
    ) {
      if (colDef.type === 'date') {
        if (operator === 'greater_than') {
          sqlParams.push(value);
          filterClauses.push(`${colSql} > $${sqlParams.length}::date`);
        } else if (operator === 'greater_than_or_equal') {
          sqlParams.push(value);
          filterClauses.push(`${colSql} >= $${sqlParams.length}::date`);
        } else if (operator === 'less_than') {
          sqlParams.push(value);
          filterClauses.push(`${colSql} < $${sqlParams.length}::date`);
        } else if (operator === 'less_than_or_equal') {
          sqlParams.push(value);
          filterClauses.push(`${colSql} <= $${sqlParams.length}::date`);
        } else if (operator === 'between') {
          sqlParams.push(value[0]);
          const p1 = sqlParams.length;
          sqlParams.push(value[1]);
          const p2 = sqlParams.length;
          filterClauses.push(`${colSql} BETWEEN $${p1}::date AND $${p2}::date`);
        }
      } else {
        filterClauses.push(
          buildNumericComparisonClause(colSql, operator, value, sqlParams)
        );
      }
    } else if (operator === 'contains') {
      sqlParams.push(`%${value}%`);
      filterClauses.push(`${colSql} ILIKE $${sqlParams.length}`);
    } else if (operator === 'not_contains') {
      sqlParams.push(`%${value}%`);
      filterClauses.push(`${colSql} NOT ILIKE $${sqlParams.length}`);
    } else if (operator === 'starts_with') {
      sqlParams.push(`${value}%`);
      filterClauses.push(`${colSql} ILIKE $${sqlParams.length}`);
    } else if (operator === 'ends_with') {
      sqlParams.push(`%${value}`);
      filterClauses.push(`${colSql} ILIKE $${sqlParams.length}`);
    } else if (operator === 'in') {
      const arr = Array.isArray(value) ? value : [value];
      const areAllUuids =
        colDef.type === 'uuid' &&
        arr.length > 0 &&
        arr.every((v) => typeof v === 'string' && UUID_REGEX.test(v.trim()));
      sqlParams.push(arr);
      if (areAllUuids) {
        filterClauses.push(`${colSql} = ANY($${sqlParams.length}::uuid[])`);
      } else if (colDef.type === 'uuid') {
        filterClauses.push(`CAST(${colSql} AS TEXT) = ANY($${sqlParams.length}::text[])`);
      } else {
        filterClauses.push(`${colSql} = ANY($${sqlParams.length}::text[])`);
      }
    } else if (operator === 'relative_days_ago') {
      sqlParams.push(value);
      filterClauses.push(
        `${colSql} >= (NOW() - ($${sqlParams.length}::integer * INTERVAL '1 day'))`
      );
    } else if (operator === 'this_month') {
      filterClauses.push(
        `${colSql} >= DATE_TRUNC('month', CURRENT_DATE) AND ${colSql} < (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month')`
      );
    }
  }

  let whereSql = schema?.columns?.workspace_id
    ? '(business_id = $1 OR workspace_id = $1)'
    : 'business_id = $1';
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
  const validatedSort = validateSort(schema, sort);
  const sortClauses = [];
  for (const s of validatedSort) {
    const sMatch = findColumnDef(schema, s.field);
    const sCol = sMatch ? sMatch.exactName : s.field;
    sortClauses.push(`${quoteIdentifier(sCol)} ${s.direction.toUpperCase()}`);
  }
  if (schema.columns.created_at) {
    sortClauses.push('"created_at" DESC');
  }
  if (schema.columns.id) {
    sortClauses.push('"id" ASC');
  }

  const safeTableName = quoteIdentifier(schema.tableName || 'products');

  let sql = `
    SELECT *
    FROM ${safeTableName}
    WHERE ${whereSql}
  `;

  if (sortClauses.length > 0) {
    sql += ` ORDER BY ${sortClauses.join(', ')}`;
  }

  if (limit && Number.isFinite(limit) && limit > 0) {
    sqlParams.push(limit);
    sql += ` LIMIT $${sqlParams.length}`;
  }

  return { sql: sql.trim(), params: sqlParams };
}

/**
 * Retrieves all rows for an active table scoped to a business.
 *
 * @param {string | object} [entity='products']
 * @param {string} businessId
 * @param {object} [options]
 * @param {boolean} [options.skipEnsure=false]
 * @returns {Promise<Array<object>>}
 */
async function getAllRows(entity = 'products', businessId, options = {}) {
  const schema = await discoverTableSchema(entity, businessId);
  if (!options.skipEnsure) {
    await ensureTableExists(schema);
  }
  const safeTableName = quoteIdentifier(schema.tableName || 'products');
  const orderClause = schema.columns.created_at
    ? 'ORDER BY "created_at" DESC, "id" ASC'
    : schema.columns.id
      ? 'ORDER BY "id" ASC'
      : '';

  const whereBizSql = schema?.columns?.workspace_id
    ? '(business_id = $1 OR workspace_id = $1)'
    : 'business_id = $1';

  const result = await query(
    `
      SELECT *
      FROM ${safeTableName}
      WHERE ${whereBizSql}
      ${orderClause};
    `,
    [businessId]
  );
  return result.rows.map((r) => normalizeProductRow(r, schema));
}

/**
 * Executes a structured query against PostgreSQL for any active inventory table.
 *
 * @param {object} params
 * @param {string | object} [params.entity='products']
 * @param {string} params.businessId
 * @param {object} params.queryJson - Interpreted query JSON
 * @returns {Promise<object>}
 */
async function executeSpreadsheetQuery({
  entity = 'products',
  businessId,
  queryJson,
  schema: suppliedSchema = null,
  skipEnsure = false,
  sourcePrompt = '',
  conversationHistory = [],
}) {
  if (!businessId) {
    throw new AppError('Business ID is required to execute a sheet query.', 400);
  }

  const schema =
    suppliedSchema || (await discoverTableSchema(entity, businessId));
  if (!skipEnsure) {
    await ensureTableExists(schema);
  }

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

  // Resolve name filters against live catalog if applicable (short-circuits when no name filter exists)
  const nameResolution = await resolveNameFilters({
    businessId,
    entity: schema,
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
  const resolvedFilters = [...nameResolution.filters];

  // Read-to-Read Filter Chaining: when user narrows prior results ("those", "them", "only the ones...")
  // intersect deterministically with prior turn's matched_row_ids on this table unless reset.
  const normalizedHistory = normalizeConversationHistory(conversationHistory);
  if (
    normalizedHistory.length > 0 &&
    filterLogic === 'AND' &&
    hasFollowUpReference(sourcePrompt) &&
    !hasExplicitScopeReset(sourcePrompt)
  ) {
    const activeCtx = getLatestActiveContext(
      normalizedHistory,
      schema.tableName || schema.entity
    );
    if (activeCtx.matchedRowIds.length > 0) {
      const idFilter = await resolveIdentifierFilterForIds(
        schema,
        businessId,
        activeCtx.matchedRowIds,
        query,
        quoteIdentifier
      );
      if (
        idFilter &&
        !resolvedFilters.some(
          (f) => String(f.field || '').toLowerCase() === idFilter.field.toLowerCase()
        )
      ) {
        resolvedFilters.push(validateFilter(schema, idFilter));
      }
    }
  }

  const { sql, params: sqlParams } = buildParameterizedSelectQuery({
    entity: schema,
    businessId,
    filters: resolvedFilters,
    filterLogic,
    sort: queryJson.sort || [],
    limit: queryJson.limit || null,
  });

  const result = await query(sql, sqlParams);
  const rows = result.rows.map((r) => normalizeProductRow(r, schema));

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
