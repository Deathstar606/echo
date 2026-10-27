const { query } = require('../../db');
const { getSchema, validateFilter, validateSort } = require('./sheetSchemaService');
const AppError = require('../utils/AppError');

/**
 * Builds a safe, parameterized SQL query for reading products or services rows.
 *
 * @param {object} params
 * @param {string} params.entity - 'products' | 'services'
 * @param {string} params.businessId - UUID of the business
 * @param {Array<{ field: string, operator: string, value: any }>} [params.filters=[]]
 * @param {Array<{ field: string, direction?: 'asc' | 'desc' }>} [params.sort=[]]
 * @param {number | null} [params.limit=null]
 * @returns {{ sql: string, params: any[] }}
 */
function buildParameterizedSelectQuery({
  entity,
  businessId,
  filters = [],
  sort = [],
  limit = null,
}) {
  const schema = getSchema(entity);
  const sqlParams = [businessId];
  const whereClauses = [`business_id = $1`];

  for (const rawFilter of filters) {
    const validated = validateFilter(entity, rawFilter);
    const { field, operator, value } = validated;
    const colDef = schema.columns[field];

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
  const validatedSort = validateSort(entity, sort);
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
 * Retrieves all rows for a given entity scoped to a business.
 *
 * @param {string} entity
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
async function getAllRows(entity, businessId) {
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
  return result.rows;
}

/**
 * Executes a structured query against PostgreSQL.
 * If queryJson asks for clarification, returns immediately without running database queries.
 *
 * @param {object} params
 * @param {string} params.entity
 * @param {string} params.businessId
 * @param {object} params.queryJson - Interpreted query JSON
 * @returns {Promise<object>}
 */
async function executeSpreadsheetQuery({ entity, businessId, queryJson }) {
  if (!businessId) {
    throw new AppError('Business ID is required to execute a sheet query.', 400);
  }

  if (queryJson.status === 'clarification_needed') {
    return {
      status: 'clarification_needed',
      message: queryJson.message,
      entity: queryJson.entity || entity,
      rows: [],
      count: 0,
    };
  }

  const { sql, params: sqlParams } = buildParameterizedSelectQuery({
    entity,
    businessId,
    filters: queryJson.filters || [],
    sort: queryJson.sort || [],
    limit: queryJson.limit || null,
  });

  const result = await query(sql, sqlParams);

  return {
    status: 'ok',
    interpretedQuery: {
      entity: queryJson.entity || entity,
      operation: 'filter',
      filters: queryJson.filters || [],
      sort: queryJson.sort || [],
      limit: queryJson.limit || null,
    },
    rows: result.rows,
    count: result.rows.length,
  };
}

module.exports = {
  buildParameterizedSelectQuery,
  getAllRows,
  executeSpreadsheetQuery,
};
