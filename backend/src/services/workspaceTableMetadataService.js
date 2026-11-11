const crypto = require('node:crypto');
const { query: defaultQuery, getPool } = require('../../db');
const {
  quoteIdentifier,
  invalidateTableSchemaCache,
} = require('./sheetSchemaService');

const METADATA_CACHE_TTL_MS = 60000;
const METADATA_CACHE_BY_POOL = new WeakMap();

function getPoolMetadataCache() {
  try {
    const pool = getPool();
    if (!pool || pool.constructor?.name !== 'Pool') {
      return null;
    }
    let store = METADATA_CACHE_BY_POOL.get(pool);
    if (!store) {
      store = new Map();
      METADATA_CACHE_BY_POOL.set(pool, store);
    }
    return store;
  } catch {
    return null;
  }
}

/**
 * Clears cached workspace table metadata for a workspace (or all workspaces when omitted).
 *
 * @param {string | null} [workspaceId]
 * @param {string | null} [tableName]
 */
function invalidateWorkspaceMetadataCache(workspaceId = null, tableName = null) {
  invalidateTableSchemaCache(workspaceId, tableName);
  const store = getPoolMetadataCache();
  if (!store) return;
  if (!workspaceId) {
    store.clear();
    return;
  }
  store.delete(String(workspaceId));
}

const SYSTEM_COLUMNS = new Set([
  'id',
  'business_id',
  'workspace_id',
  'user_id',
  'created_at',
  'updated_at',
  'workspace_document_id',
]);

function normalizeProfileType(column) {
  const type = String(column.udt_name || column.data_type || '').toLowerCase();
  if (type === 'json' || type === 'jsonb' || type === '_json' || type === '_jsonb') {
    return 'jsonb';
  }
  if (
    ['smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision'].includes(
      String(column.data_type || '').toLowerCase()
    )
  ) {
    return 'numeric';
  }
  if (type === 'bool' || String(column.data_type).toLowerCase() === 'boolean') {
    return 'boolean';
  }
  if (
    ['date', 'timestamp', 'timestamptz', 'time', 'timetz'].includes(type) ||
    /^(?:date|timestamp|time)/i.test(String(column.data_type || ''))
  ) {
    return 'date';
  }
  return 'text';
}

function inferSemanticRole(column, values = [], primaryKeyColumn = null) {
  const name = String(column.column_name || '').toLowerCase();
  const type = normalizeProfileType(column);
  if (name === String(primaryKeyColumn || '').toLowerCase() || /(?:^|_)(?:id|code|sku|ref|reference|number|no)(?:$|_)/i.test(name)) {
    return 'identifier';
  }
  if (/email|e_mail|contact_mail/i.test(name) || values.some((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '')))) {
    return 'email';
  }
  if (type === 'jsonb') return 'json_map';
  if (type === 'boolean' || /status|state|flag|active|enabled|issued|verified|ready/i.test(name)) {
    return 'status_flag';
  }
  if (/price|cost|amount|balance|credit|discount|revenue|spend|rate|salary|value|total|subtotal|limit/i.test(name)) {
    return 'financial_metric';
  }
  if (/qty|quantity|count|stock|inventory|beds|units|ordered|allocated|capacity|level|hours|days|months|age|number/i.test(name)) {
    return 'quantity';
  }
  return 'descriptive_text';
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildTenantPredicate(columns) {
  const names = new Set(columns.map((column) => String(column.column_name).toLowerCase()));
  const tenantColumns = ['business_id', 'workspace_id'].filter((name) => names.has(name));
  if (tenantColumns.length === 0) {
    throw new Error('Cannot profile a table without a business_id or workspace_id column.');
  }
  return tenantColumns.length === 2
    ? `("business_id" = $1 OR "workspace_id" = $1)`
    : `${quoteIdentifier(tenantColumns[0])} = $1`;
}

function choosePrimaryIdentifier(columns, primaryKeys, stats, rowCount) {
  const domainIdentifier = columns.find((column) => {
    const name = String(column.column_name).toLowerCase();
    return !SYSTEM_COLUMNS.has(name) &&
      /(?:^|_)(?:order|account|backorder|unit|customer|product|record|ticket|invoice|shipment)?_?(?:id|code|sku|ref|reference|number|no)(?:$|_)/i.test(name) &&
      (rowCount === 0 || Number(stats[column.column_name]?.distinct_count) === rowCount);
  });
  if (domainIdentifier) return domainIdentifier.column_name;
  const appPrimary = primaryKeys.find((name) => !SYSTEM_COLUMNS.has(String(name).toLowerCase()));
  if (appPrimary) return appPrimary;
  return columns.find((column) => String(column.column_name).toLowerCase() === 'id')?.column_name || null;
}

function parseNestedValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !/^\s*[{[]/.test(value)) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function nestedValueType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function inferNestedStructure(values, depth = 0) {
  if (depth >= 3) return null;
  const parsedValues = values.map(parseNestedValue).filter(Boolean);
  if (parsedValues.length === 0) return null;

  if (parsedValues.every(Array.isArray)) {
    const items = parsedValues.flat();
    return {
      type: 'array',
      observed_item_types: [...new Set(items.map(nestedValueType))],
      item_structure: inferNestedStructure(items, depth + 1),
    };
  }
  const objects = parsedValues.filter(
    (value) => !Array.isArray(value) && typeof value === 'object'
  );
  if (objects.length === 0) return null;

  const keyNames = [...new Set(objects.flatMap((value) => Object.keys(value)))].slice(0, 40);
  return {
    type: 'object_map',
    sampled_row_count: objects.length,
    observed_keys: keyNames.map((name) => {
      const observedValues = objects
        .filter((value) => Object.prototype.hasOwnProperty.call(value, name))
        .map((value) => value[name]);
      const valueTypes = [...new Set(observedValues.map(nestedValueType))];
      return {
        name,
        observed_in_sample_count: observedValues.length,
        value_types: valueTypes,
        nested_structure: inferNestedStructure(observedValues, depth + 1),
      };
    }),
  };
}

function redactSampleRows(rows, emailColumn) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(([column]) =>
        column.toLowerCase() !== String(emailColumn || '').toLowerCase() &&
        !/(?:^|_)(?:email|e_mail|phone|mobile|address|contact_person|customer_name|buyer_name|account_manager)(?:$|_)/i.test(column)
      )
    )
  );
}

function buildTableSummary(tableName, columns, primaryKeyColumn) {
  const displayColumns = columns
    .filter((column) => !SYSTEM_COLUMNS.has(String(column.column_name).toLowerCase()))
    .slice(0, 5)
    .map((column) => column.column_name);
  return `${tableName} stores workspace records${primaryKeyColumn ? ` identified by ${primaryKeyColumn}` : ''}. Key columns include ${displayColumns.join(', ') || 'the table schema'}.`;
}

function buildColumnStatsSql(tableName, columns, tenantPredicate) {
  const expressions = [];
  for (const column of columns) {
    const name = column.column_name;
    const quoted = quoteIdentifier(name);
    const literal = quoteLiteral(name);
    const type = normalizeProfileType(column);
    const distinctValues = `(SELECT COALESCE(jsonb_agg(to_jsonb(value)), '[]'::jsonb) FROM (SELECT DISTINCT ${quoted}::text AS value FROM ${quoteIdentifier(tableName)} WHERE ${tenantPredicate} AND ${quoted} IS NOT NULL ORDER BY value LIMIT 26) AS distinct_values)`;
    const numericStats = type === 'numeric'
      ? `jsonb_build_object('min', MIN(${quoted}), 'max', MAX(${quoted}))`
      : `'{}'::jsonb`;
    expressions.push(`${literal}, jsonb_build_object(
      'distinct_count', COUNT(DISTINCT ${quoted}),
      'categorical_values', ${distinctValues},
      'numeric_stats', ${numericStats}
    )`);
  }
  return `SELECT COUNT(*)::bigint AS row_count, jsonb_build_object(${expressions.join(', ')}) AS column_stats FROM ${quoteIdentifier(tableName)} WHERE ${tenantPredicate};`;
}

function buildScopedIndexName(tableName, suffix) {
  const digest = crypto.createHash('sha1').update(`${tableName}:${suffix}`).digest('hex').slice(0, 10);
  const safePrefix = String(tableName).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 38);
  return `idx_wtm_${safePrefix}_${suffix}_${digest}`;
}

async function ensureWorkspaceIndexes({ client, workspaceId, tableName, primaryKeyColumn }) {
  const executor = client || { query: defaultQuery };
  const columnsResult = await executor.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1;`,
    [tableName]
  );
  const columns = columnsResult.rows || [];
  const tenantColumns = ['business_id', 'workspace_id'].filter((name) =>
    columns.some((column) => String(column.column_name).toLowerCase() === name)
  );
  if (tenantColumns.length === 0) return;
  const indexesResult = await executor.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1;`,
    [tableName]
  );
  const indexDefinitions = (indexesResult.rows || []).map((row) =>
    String(row.indexdef || '').toLowerCase()
  );
  const tableSql = quoteIdentifier(tableName);
  const hasPrimaryKeyColumn = columns.some((column) => column.column_name === primaryKeyColumn);
  for (const tenantColumn of tenantColumns) {
    const escapedTenant = tenantColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tenantPattern = new RegExp(`\\(\\s*"?${escapedTenant}"?\\s*(?:,|\\))`, 'i');
    if (!indexDefinitions.some((index) => tenantPattern.test(index))) {
      const suffix = tenantColumn === 'workspace_id' ? 'workspace' : 'business';
      const tenantIndex = quoteIdentifier(buildScopedIndexName(tableName, suffix));
      await executor.query(
        `CREATE INDEX IF NOT EXISTS ${tenantIndex} ON ${tableSql} (${quoteIdentifier(tenantColumn)});`
      );
    }

    if (primaryKeyColumn && hasPrimaryKeyColumn) {
      const escapedPrimary = String(primaryKeyColumn).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const compositePattern = new RegExp(
        `\\(\\s*"?${escapedTenant}"?\\s*,\\s*"?${escapedPrimary}"?\\s*\\)`,
        'i'
      );
      if (!indexDefinitions.some((index) => compositePattern.test(index))) {
        const suffix = tenantColumn === 'workspace_id' ? 'workspace_key' : 'business_key';
        const compositeIndex = quoteIdentifier(buildScopedIndexName(tableName, suffix));
        await executor.query(
          `CREATE INDEX IF NOT EXISTS ${compositeIndex} ON ${tableSql} (${quoteIdentifier(tenantColumn)}, ${quoteIdentifier(primaryKeyColumn)});`
        );
      }
    }
  }
}

async function refreshWorkspaceTableMetadata({
  client,
  workspaceId,
  tableName,
  sourceFilename,
}) {
  if (!workspaceId || !tableName) {
    throw new Error('workspaceId and tableName are required to profile a workspace table.');
  }
  const executor = client || { query: defaultQuery };
  const safeTableName = String(tableName);
  const columnsResult = await executor.query(
    `SELECT column_name, data_type, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position;`,
    [safeTableName]
  );
  const columns = columnsResult.rows || [];
  const tenantPredicate = buildTenantPredicate(columns);
  const primaryKeyResult = await executor.query(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = $1
       AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position;`,
    [safeTableName]
  );
  const declaredPrimaryKeys = (primaryKeyResult.rows || []).map((row) => row.column_name);
  const profileSql = buildColumnStatsSql(safeTableName, columns, tenantPredicate);
  const profileResult = await executor.query(profileSql, [workspaceId]);
  const rowCount = Number(profileResult.rows?.[0]?.row_count || 0);
  const stats = profileResult.rows?.[0]?.column_stats || {};
  const primaryKeyColumn = choosePrimaryIdentifier(columns, declaredPrimaryKeys, stats, rowCount);
  const sampleResult = await executor.query(
    `SELECT * FROM ${quoteIdentifier(safeTableName)} WHERE ${tenantPredicate} LIMIT 3;`,
    [workspaceId]
  );
  const emailColumn =
    columns.find((column) => /email|e_mail|contact_mail/i.test(column.column_name))?.column_name ||
    columns.find((column) =>
      (sampleResult.rows || []).some((row) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row[column.column_name] ?? ''))
      )
    )?.column_name ||
    null;
  const sampleRows = redactSampleRows(sampleResult.rows || [], emailColumn);

  const columnsProfile = columns.map((column) => {
    const columnStats = stats[column.column_name] || {};
    const semanticRole = inferSemanticRole(column, [], primaryKeyColumn);
    const rawCategoricalValues = Array.isArray(columnStats.categorical_values)
      ? columnStats.categorical_values.map((item) => item?.value ?? item)
      : [];
    const categoricalValues =
      Number(columnStats.distinct_count) <= 25 &&
      !/(?:^|_)(?:name|email|e_mail|phone|mobile|address|contact|manager)(?:$|_)/i.test(column.column_name)
        ? rawCategoricalValues
        : [];
    const numericStats = columnStats.numeric_stats || {};
    return {
      column_name: column.column_name,
      data_type: normalizeProfileType(column),
      semantic_role: semanticRole,
      categorical_values: categoricalValues,
      nested_structure: inferNestedStructure(
        (sampleResult.rows || []).map((row) => row[column.column_name])
      ),
      numeric_stats:
        Object.keys(numericStats).length > 0
          ? {
              min: numericStats.min === null ? null : Number(numericStats.min),
              max: numericStats.max === null ? null : Number(numericStats.max),
            }
          : null,
    };
  });
  const priorMetadata = sourceFilename
    ? null
    : await executor.query(
        `SELECT source_filename FROM workspace_table_metadata
         WHERE workspace_id = $1 AND table_name = $2;`,
        [workspaceId, safeTableName]
      );
  const resolvedSourceFilename =
    sourceFilename ||
    priorMetadata?.rows?.[0]?.source_filename ||
    `${safeTableName}.csv`;
  const summary = buildTableSummary(safeTableName, columns, primaryKeyColumn);
  const upsertResult = await executor.query(
    `INSERT INTO workspace_table_metadata
       (workspace_id, table_name, source_filename, row_count, primary_key_column, email_column,
        columns_profile, sample_rows, table_summary, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, NOW())
     ON CONFLICT (workspace_id, table_name)
     DO UPDATE SET source_filename = EXCLUDED.source_filename,
       row_count = EXCLUDED.row_count,
       primary_key_column = EXCLUDED.primary_key_column,
       email_column = EXCLUDED.email_column,
       columns_profile = EXCLUDED.columns_profile,
       sample_rows = EXCLUDED.sample_rows,
       table_summary = EXCLUDED.table_summary,
       updated_at = NOW()
     RETURNING *;`,
    [
      workspaceId,
      safeTableName,
      resolvedSourceFilename,
      rowCount,
      primaryKeyColumn,
      emailColumn,
      JSON.stringify(columnsProfile),
      JSON.stringify(sampleRows),
      summary,
    ]
  );
  await ensureWorkspaceIndexes({
    client: executor,
    workspaceId,
    tableName: safeTableName,
    primaryKeyColumn,
  });
  invalidateWorkspaceMetadataCache(workspaceId);
  return upsertResult.rows?.[0] || {
    workspace_id: workspaceId,
    table_name: safeTableName,
    source_filename: resolvedSourceFilename,
    row_count: rowCount,
    primary_key_column: primaryKeyColumn,
    email_column: emailColumn,
    columns_profile: columnsProfile,
    sample_rows: sampleRows,
    table_summary: summary,
  };
}

async function listWorkspaceTableMetadata(workspaceId) {
  const result = await defaultQuery(
    `SELECT id, workspace_id, table_name, source_filename, row_count,
            primary_key_column, email_column, columns_profile, sample_rows,
            table_summary, updated_at
     FROM workspace_table_metadata
     WHERE workspace_id = $1
     ORDER BY table_name;`,
    [workspaceId]
  );
  return result.rows || [];
}

/**
 * Returns workspace table metadata rows using a pool-scoped TTL cache on live PostgreSQL pools.
 *
 * @param {string} workspaceId
 * @returns {Promise<Array<object>>}
 */
async function listWorkspaceTableMetadataCached(workspaceId) {
  const store = getPoolMetadataCache();
  const key = String(workspaceId || '');
  if (store && key) {
    const cached = store.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.rows;
    }
  }
  const rows = await listWorkspaceTableMetadata(workspaceId);
  if (store && key) {
    store.set(key, {
      rows,
      expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
    });
  }
  return rows;
}

module.exports = {
  normalizeProfileType,
  inferSemanticRole,
  inferNestedStructure,
  buildTenantPredicate,
  choosePrimaryIdentifier,
  redactSampleRows,
  buildTableSummary,
  refreshWorkspaceTableMetadata,
  listWorkspaceTableMetadata,
  listWorkspaceTableMetadataCached,
  invalidateWorkspaceMetadataCache,
};
