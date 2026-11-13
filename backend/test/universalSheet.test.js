const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { setPool } = require('../db');
const {
  setSheetGeminiGenerator,
  setWorkspaceGeminiGenerator,
} = require('../src/services/geminiService');
const {
  discoverTableSchema,
  getSchema,
  registerTableSchema,
  validateMutation,
} = require('../src/services/sheetSchemaService');
const {
  computeRowUpdates,
  buildParameterizedUpdateStatement,
} = require('../src/services/sheetMutationService');
const { buildSheetQueryPrompt } = require('../src/services/sheetQueryPromptBuilder');
const {
  retrieveRelevantContextForBusiness,
} = require('../src/services/contextRetrievalService');

/**
 * Creates an in-memory PostgreSQL simulator supporting products, electronics_inventory,
 * grocery_inventory, dynamic information_schema inspection, and parameterized queries.
 */
function createUniversalSheetPool() {
  const businesses = new Map();
  const tables = new Map();
  const queryLog = [];
  let workspaceTableMetadata = [];

  let monotonicClock = Date.now();
  let failNextUpdate = false;

  function nextIsoTimestamp() {
    monotonicClock = Math.max(Date.now(), monotonicClock + 1);
    return new Date(monotonicClock).toISOString();
  }

  // Seed business
  const businessId = '684a8863-5094-4c8b-9b15-c50c06335b7f';
  businesses.set(businessId, {
    id: businessId,
    name: 'Universal Inventory Test Business',
    created_at: nextIsoTimestamp(),
  });

  tables.set('products', []);
  tables.set('electronics_inventory', []);
  tables.set('grocery_inventory', []);

  function cloneState() {
    return {
      businesses: new Map(Array.from(businesses.entries()).map(([k, v]) => [k, { ...v }])),
      tables: new Map(
        Array.from(tables.entries()).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))])
      ),
      workspaceTableMetadata: workspaceTableMetadata.map((row) => ({ ...row })),
    };
  }

  function restoreState(snap) {
    for (const [k, rows] of snap.tables.entries()) {
      tables.set(k, rows);
    }
    workspaceTableMetadata = snap.workspaceTableMetadata;
  }

  function compareNumbers(actual, op, target) {
    switch (op) {
      case '=':
        return actual === target;
      case '<>':
        return actual !== target;
      case '>':
        return actual > target;
      case '<':
        return actual < target;
      case '>=':
        return actual >= target;
      case '<=':
        return actual <= target;
      default:
        return false;
    }
  }

  function evaluateUniversalCondition(clauseSql, row, params) {
    const trimmed = clauseSql.replace(/"/g, '').trim();

    // 1. Nested size.<KEY> integer comparison
    const sizeKeyMatch = trimmed.match(
      /\(([a-z0-9_]+)::jsonb\s*->>\s*\$(\d+)\)[\s\S]+?,\s*0\)\s*(=|<>|>=|<=|>|<)\s*\$(\d+)/i
    );
    if (sizeKeyMatch) {
      const mapField = sizeKeyMatch[1].toLowerCase();
      const sizeKey = String(params[Number(sizeKeyMatch[2]) - 1]);
      const op = sizeKeyMatch[3];
      const targetVal = Number(params[Number(sizeKeyMatch[4]) - 1]);
      let actualVal = 0;
      try {
        const source = row[mapField] || '{}';
        const parsed = typeof source === 'string' ? JSON.parse(source) : source;
        actualVal = Number.isFinite(Number(parsed[sizeKey])) ? Number(parsed[sizeKey]) : 0;
      } catch {
        actualVal = 0;
      }
      return compareNumbers(actualVal, op, targetVal);
    }

    // 2. Date comparison: col (<|<=|>|>=|=) $N::date
    const dateMatch = trimmed.match(/^([a-z0-9_]+)\s*(=|<>|>=|<=|>|<)\s*\$(\d+)::date$/i);
    if (dateMatch) {
      const col = dateMatch[1];
      const op = dateMatch[2];
      const targetDate = String(params[Number(dateMatch[3]) - 1]).slice(0, 10);
      const rowVal = row[col] ?? row[col.toLowerCase()] ?? row[col.toUpperCase()];
      const actualDate = String(rowVal || '').slice(0, 10);
      return compareNumbers(actualDate, op, targetDate);
    }

    // 3. Numeric comparison: col (=|<>|>=|<=|>|<) $N
    const numMatch = trimmed.match(/^([a-z0-9_]+)\s*(=|<>|>=|<=|>|<)\s*\$(\d+)$/i);
    if (numMatch) {
      const col = numMatch[1];
      const op = numMatch[2];
      const targetVal = Number(params[Number(numMatch[3]) - 1]);
      const rowVal = row[col] ?? row[col.toLowerCase()] ?? row[col.toUpperCase()];
      const actualVal = Number(rowVal);
      if (Number.isFinite(actualVal) && Number.isFinite(targetVal)) {
        return compareNumbers(actualVal, op, targetVal);
      }
    }

    // 4. Boolean comparison: col = $N
    const boolMatch = trimmed.match(/^([a-z0-9_]+)\s*(=|<>)\s*\$(\d+)$/i);
    if (boolMatch) {
      const col = boolMatch[1];
      const op = boolMatch[2];
      const paramVal = params[Number(boolMatch[3]) - 1];
      if (typeof paramVal === 'boolean') {
        const rowVal = Boolean(row[col] ?? row[col.toLowerCase()] ?? row[col.toUpperCase()]);
        return op === '=' ? rowVal === paramVal : rowVal !== paramVal;
      }
    }

    // 5. Case-insensitive exact string: LOWER(col) = LOWER($N)
    const lowerEqMatch = trimmed.match(/^LOWER\(([a-z0-9_]+)\)\s*(=|<>)\s*LOWER\(\$(\d+)\)$/i);
    if (lowerEqMatch) {
      const col = lowerEqMatch[1];
      const op = lowerEqMatch[2];
      const targetStr = String(params[Number(lowerEqMatch[3]) - 1] ?? '').toLowerCase();
      const rowVal = row[col] ?? row[col.toLowerCase()] ?? row[col.toUpperCase()];
      const actualStr = String(rowVal ?? '').toLowerCase();
      return op === '=' ? actualStr === targetStr : actualStr !== targetStr;
    }

    // 6. ILIKE pattern: col ILIKE $N
    const ilikeMatch = trimmed.match(/^([a-z0-9_]+)(?:::\w+)?\s+ILIKE\s+\$(\d+)$/i);
    if (ilikeMatch) {
      const col = ilikeMatch[1];
      const pattern = String(params[Number(ilikeMatch[2]) - 1] ?? '').toLowerCase();
      const rowVal = row[col] ?? row[col.toLowerCase()] ?? row[col.toUpperCase()];
      const actual = String(rowVal ?? '').toLowerCase();
      if (pattern.startsWith('%') && pattern.endsWith('%')) {
        return actual.includes(pattern.slice(1, -1));
      }
      if (pattern.endsWith('%')) {
        return actual.startsWith(pattern.slice(0, -1));
      }
      return actual === pattern;
    }

    // 7. IN operator: col = ANY($N::text[]) or uuid[]
    const anyMatch = trimmed.match(/^([a-z0-9_]+)\s*=\s*ANY\(\$(\d+)::(?:text|uuid)\[\]\)$/i);
    if (anyMatch) {
      const col = anyMatch[1];
      const arr = params[Number(anyMatch[2]) - 1];
      if (!Array.isArray(arr)) return false;
      const rowVal = row[col] ?? row[col.toLowerCase()] ?? row[col.toUpperCase()];
      return arr.some((item) => String(item).toLowerCase() === String(rowVal ?? '').toLowerCase());
    }

    return true;
  }

  function applyUniversalAssignment(assignSql, row, params) {
    const trimmed = assignSql.replace(/"/g, '').trim();
    if (/^updated_at\s*=\s*NOW\(\)$/i.test(trimmed)) return;

    // Check if percentage update
    if (trimmed.includes('/ 100.0')) {
      const colName = trimmed.split('=')[0].trim();
      const sign = trimmed.includes('(1 +') ? '+' : '-';
      const paramMatch = trimmed.match(/\$(\d+)/);
      if (paramMatch) {
        const pct = Number(params[Number(paramMatch[1]) - 1]);
        const factor = sign === '+' ? 1 + pct / 100 : 1 - pct / 100;
        const cur = Number(row[colName] ?? row[colName.toLowerCase()] ?? 0);
        const finalVal = Math.round(cur * factor * 100) / 100;
        row[colName] = finalVal;
        row[colName.toLowerCase()] = finalVal;
        return;
      }
    }

    // 2. Add / Subtract / Multiply arithmetic: col = col ± $N or ROUND((col ± $N)...)
    const arithMatch = trimmed.match(
      /^([a-z0-9_]+)\s*=\s*(?:ROUND\(\(?)?\1\s*([+\-*])\s*\$(\d+)(?:::numeric|::integer)?\)?(?:::numeric)?(?:,\s*2)?\)?(?:::integer)?$/i
    );
    if (arithMatch) {
      const col = arithMatch[1];
      const op = arithMatch[2];
      const operand = Number(params[Number(arithMatch[3]) - 1]);
      const cur = Number(row[col] ?? row[col.toLowerCase()] ?? row[col.toUpperCase()] ?? 0);
      let raw = cur;
      if (op === '+') raw = cur + operand;
      else if (op === '-') raw = cur - operand;
      else if (op === '*') raw = cur * operand;
      const finalVal = Math.round(raw * 100) / 100;
      row[col] = finalVal;
      row[col.toLowerCase()] = finalVal;
      return;
    }

    // 3. Nested map CASE id
    const mapCaseMatch = trimmed.match(/^([a-z0-9_]+)\s*=\s*CASE\s+id/i);
    if (mapCaseMatch) {
      const mapField = mapCaseMatch[1];
      const whenMatches = [...trimmed.matchAll(/WHEN\s+\$(\d+)::uuid\s+THEN\s+\$(\d+)/gi)];
      for (const m of whenMatches) {
        const idParam = params[Number(m[1]) - 1];
        const valParam = params[Number(m[2]) - 1];
        if (row.id === idParam) {
          row[mapField] = valParam;
          return;
        }
      }
      return;
    }

    // 4. Direct scalar assignment: col = $N
    const directMatch = trimmed.match(/^([a-z0-9_]+)\s*=\s*\$(\d+)$/i);
    if (directMatch) {
      const col = directMatch[1];
      const val = params[Number(directMatch[2]) - 1];
      row[col] = val;
      if (row[col.toLowerCase()] !== undefined) row[col.toLowerCase()] = val;
    }
  }

  async function executeQuery(sql, params = []) {
    const rawSql = sql.trim();
    const normalized = rawSql.replace(/\s+/g, ' ').toUpperCase();
    queryLog.push({ sql: rawSql, params: [...params] });

    // 1. SELECT 1
    if (normalized === 'SELECT 1;' || normalized === 'SELECT 1') {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    // DDL: CREATE TABLE, CREATE INDEX, ALTER TABLE, CREATE EXTENSION
    if (
      normalized.startsWith('CREATE TABLE') ||
      normalized.startsWith('CREATE INDEX') ||
      normalized.startsWith('ALTER TABLE') ||
      normalized.startsWith('CREATE EXTENSION')
    ) {
      const tblMatch = rawSql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-z0-9_]+)["']?/i);
      if (tblMatch) {
        const tName = tblMatch[1].toLowerCase();
        if (!tables.has(tName)) tables.set(tName, []);
      }
      return { rows: [], rowCount: 0 };
    }

    // information_schema.tables introspection
    if (normalized.includes('FROM INFORMATION_SCHEMA.TABLES')) {
      if (normalized.startsWith('SELECT TABLE_NAME')) {
        const rows = Array.from(tables.keys()).map((table_name) => ({ table_name }));
        return { rows, rowCount: rows.length };
      }
      const requestedTable = String(params[0] || '').toLowerCase();
      const exists = tables.has(requestedTable);
      return {
        rows: exists ? [{ exists: true }] : [],
        rowCount: exists ? 1 : 0,
      };
    }

    // 2. Workspace / Business lookup & insert
    if (normalized.startsWith('SELECT ID FROM USERS ORDER BY CREATED_AT ASC LIMIT 1')) {
      return { rows: [], rowCount: 0 };
    }
    if (
      normalized.startsWith('INSERT INTO BUSINESSES') ||
      normalized.startsWith('INSERT INTO WORKSPACES')
    ) {
      const id = params[0] || crypto.randomUUID();
      const name = params[1] || 'Test Business';
      const userId = params[2] || null;
      const created = { id, name, user_id: userId, created_at: nextIsoTimestamp() };
      businesses.set(id, created);
      return { rows: [created], rowCount: 1 };
    }
    if (
      normalized.startsWith('SELECT ID, NAME, CREATED_AT FROM BUSINESSES WHERE ID = $1') ||
      normalized.startsWith('SELECT ID, NAME, USER_ID, CREATED_AT FROM WORKSPACES WHERE ID = $1')
    ) {
      const b = businesses.get(params[0]);
      return b ? { rows: [{ ...b }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    // 3. information_schema.columns introspection
    if (normalized.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
      const requestedTable = String(params[0] || '').toLowerCase();
      const schemaDef = getSchema(requestedTable);
      if (!schemaDef) {
        return { rows: [], rowCount: 0 };
      }
      const rows = Object.entries(schemaDef.columns).map(([colKey, colDef]) => ({
        column_name: colDef.exactName || colKey,
        data_type: colDef.type === 'integer' ? 'integer' : colDef.type === 'number' ? 'numeric' : colDef.type,
        udt_name: colDef.storageType || (colDef.type === 'integer' ? 'int4' : colDef.type === 'number' ? 'numeric' : colDef.type),
        is_nullable: 'YES',
      }));
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith('SELECT COUNT(*)::BIGINT AS ROW_COUNT')) {
      const tableMatch = rawSql.match(/FROM\s+"?([a-z0-9_]+)"?\s+WHERE/i);
      const rows = tableMatch
        ? (tables.get(tableMatch[1].toLowerCase()) || []).filter(
            (row) => row.business_id === params[0] || row.workspace_id === params[0]
          )
        : [];
      return {
        rows: [{ row_count: rows.length, column_stats: {} }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith('SELECT * FROM') && /\sLIMIT 3;?$/i.test(rawSql)) {
      const tableMatch = rawSql.match(/FROM\s+"?([a-z0-9_]+)"?\s+WHERE/i);
      const rows = tableMatch
        ? (tables.get(tableMatch[1].toLowerCase()) || [])
            .filter((row) => row.business_id === params[0] || row.workspace_id === params[0])
            .slice(0, 3)
            .map((row) => ({ ...row }))
        : [];
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith('SELECT SOURCE_FILENAME FROM WORKSPACE_TABLE_METADATA')) {
      const row = workspaceTableMetadata.find(
        (metadata) =>
          metadata.workspace_id === params[0] && metadata.table_name === params[1]
      );
      return { rows: row ? [{ source_filename: row.source_filename }] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('INSERT INTO WORKSPACE_TABLE_METADATA')) {
      const row = {
        id: crypto.randomUUID(),
        workspace_id: params[0],
        table_name: params[1],
        source_filename: params[2],
        row_count: params[3],
        primary_key_column: params[4],
        email_column: params[5],
        columns_profile: JSON.parse(params[6]),
        sample_rows: JSON.parse(params[7]),
        table_summary: params[8],
      };
      workspaceTableMetadata = workspaceTableMetadata.filter(
        (metadata) =>
          metadata.workspace_id !== row.workspace_id ||
          metadata.table_name !== row.table_name
      );
      workspaceTableMetadata.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (normalized.startsWith('SELECT ID, WORKSPACE_ID, TABLE_NAME, SOURCE_FILENAME')) {
      const rows = workspaceTableMetadata
        .filter((metadata) => metadata.workspace_id === params[0])
        .sort((a, b) => a.table_name.localeCompare(b.table_name))
        .map((metadata) => ({ ...metadata }));
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith('SELECT INDEXDEF FROM PG_INDEXES')) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('CREATE INDEX IF NOT EXISTS')) {
      return { rows: [], rowCount: 0 };
    }

    // Representative-value sample with a schema-whitelisted column projection.
    const sampleMatch = rawSql.match(
      /^SELECT\s+([\s\S]+?)\s+FROM\s+"?([a-z0-9_]+)"?\s+WHERE\s+(?:business_id\s*=\s*\$1|\(\s*business_id\s*=\s*\$1\s+OR\s+workspace_id\s*=\s*\$1\s*\))\s+LIMIT\s+5;?$/i
    );
    if (sampleMatch && !sampleMatch[1].trim().startsWith('*')) {
      const selectedColumns = sampleMatch[1]
        .split(',')
        .map((column) => column.trim().replace(/^"|"$/g, ''));
      const rows = (tables.get(sampleMatch[2].toLowerCase()) || [])
        .filter((row) => row.business_id === params[0])
        .slice(0, 5)
        .map((row) => Object.fromEntries(
          selectedColumns.map((column) => [
            column,
            row[column] ?? row[column.toLowerCase()],
          ])
        ));
      return { rows, rowCount: rows.length };
    }

    const distinctCatalogMatch = rawSql.match(
      /^SELECT\s+DISTINCT\s+"([^"]+)"\s+AS\s+(name|category)\s+FROM\s+"?([a-z0-9_]+)"?\s+WHERE\s+(?:business_id\s*=\s*\$1|\(\s*business_id\s*=\s*\$1\s+OR\s+workspace_id\s*=\s*\$1\s*\))\s+AND\s+"([^"]+)"\s+IS\s+NOT\s+NULL\s+ORDER\s+BY\s+\2\s+LIMIT\s+\$2;?$/i
    );
    if (distinctCatalogMatch) {
      const [, column, alias, tableName] = distinctCatalogMatch;
      const rows = [...new Set(
        (tables.get(tableName.toLowerCase()) || [])
          .filter((row) => row.business_id === params[0])
          .map((row) => row[column] ?? row[column.toLowerCase()])
          .filter((value) => value !== null && value !== undefined)
      )]
        .sort((a, b) => String(a).localeCompare(String(b)))
        .slice(0, params[1])
        .map((value) => ({ [alias.toLowerCase()]: value }));
      return { rows, rowCount: rows.length };
    }

    // 4a. Context entries lookup
    if (normalized.includes('FROM CONTEXT_ENTRIES WHERE BUSINESS_ID = $1')) {
      const rows = (tables.get('context_entries') || []).filter(
        (r) => r.business_id === params[0]
      );
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }

    // 4b. Full products lookup with explicit column list
    if (
      normalized.startsWith(
        'SELECT ID, BUSINESS_ID, NAME, CATEGORY, DESCRIPTION, BEST, COLOR, DISCOUNT, ORDERED, IMAGES, SIZE, PRICE'
      )
    ) {
      const rows = (tables.get('products') || []).filter(
        (r) => r.business_id === params[0]
      );
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }

    // 4c. Catalog names lookup: SELECT ... FROM <table> WHERE business_id = $1 ORDER BY ...
    const catMatch = rawSql.match(/SELECT\s+([^FROM]+)\s+FROM\s+["']?([a-z0-9_]+)["']?\s+WHERE\s+(?:business_id\s*=\s*\$1|\(\s*business_id\s*=\s*\$1\s+OR\s+workspace_id\s*=\s*\$1\s*\))\s+ORDER\s+BY/i);
    if (catMatch && !rawSql.includes('FOR UPDATE') && !rawSql.includes('*')) {
      const tableName = catMatch[2].toLowerCase();
      const rows = tables.get(tableName) || [];
      const bizRows = rows
        .filter((r) => r.business_id === params[0])
        .map((r) => ({
          name: r.name || r.Product_Name || r.Item_Name,
          category: r.category || r.Brand_Name || r.Supplier,
        }));
      return { rows: bizRows, rowCount: bizRows.length };
    }

    // 5. DELETE FROM <table> WHERE business_id = $1
    const delAllMatch = rawSql.match(/^DELETE\s+FROM\s+["']?([a-z0-9_]+)["']?\s+WHERE\s+(?:business_id\s*=\s*\$1(?:\s+OR\s+workspace_id\s*=\s*\$1)?|\(\s*business_id\s*=\s*\$1\s+OR\s+workspace_id\s*=\s*\$1\s*\));?$/i);
    if (delAllMatch) {
      const tableName = delAllMatch[1].toLowerCase();
      const before = tables.get(tableName) || [];
      const after = before.filter((r) => r.business_id !== params[0]);
      tables.set(tableName, after);
      return { rows: [], rowCount: before.length - after.length };
    }

    // 6. INSERT INTO <table> (supports single-row and multi-row batch inserts)
    const insertMatch = rawSql.match(/INSERT\s+INTO\s+["']?([a-z0-9_]+)["']?\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const tableName = insertMatch[1].toLowerCase();
      const cols = insertMatch[2].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
      const firstTupleMatch = rawSql.match(/VALUES\s*\(([^)]+)\)/i);
      const placeholdersInTuple = (firstTupleMatch ? firstTupleMatch[1].match(/\$\d+/g) || [] : []).length;
      const paramsPerRow = placeholdersInTuple > 0 ? placeholdersInTuple : cols.length;
      const numRows = Math.max(1, Math.floor(params.length / paramsPerRow));
      const insertedRows = [];

      if (!tables.has(tableName)) tables.set(tableName, []);
      const tableRows = tables.get(tableName);

      for (let r = 0; r < numRows; r += 1) {
        const rowParams = params.slice(r * paramsPerRow, (r + 1) * paramsPerRow);
        const row = { id: crypto.randomUUID(), created_at: nextIsoTimestamp(), updated_at: nextIsoTimestamp() };
        let pIdx = 0;
        cols.forEach((col) => {
          const colLow = col.toLowerCase();
          if (colLow === 'created_at' || colLow === 'updated_at') {
            // Timestamp already generated
          } else if (pIdx < rowParams.length) {
            row[col] = rowParams[pIdx];
            row[colLow] = rowParams[pIdx];
            pIdx += 1;
          }
        });
        tableRows.push(row);
        insertedRows.push(row);
      }

      return { rows: insertedRows, rowCount: insertedRows.length };
    }

    // 7. SELECT * FROM <table>
    const selectMatch = rawSql.match(/SELECT\s+\*\s+FROM\s+["']?([a-z0-9_]+)["']?\s+WHERE\s+(?:business_id\s*=\s*\$1|\(\s*business_id\s*=\s*\$1\s+OR\s+workspace_id\s*=\s*\$1\s*\))/i);
    if (selectMatch) {
      const tableName = selectMatch[1].toLowerCase();
      const rows = tables.get(tableName) || [];
      let filtered = rows.filter((r) => r.business_id === params[0]);

      // ID lock: AND id = ANY($2::uuid[])
      if (Array.isArray(params[1]) && rawSql.includes('ANY($2::uuid[])')) {
        const idSet = new Set(params[1]);
        filtered = filtered.filter((r) => idSet.has(r.id));
        return { rows: filtered.map((r) => ({ ...r })), rowCount: filtered.length };
      }

      // Extra conditions
      const wherePartMatch = rawSql.match(/WHERE\s+(?:business_id\s*=\s*\$1|\(\s*business_id\s*=\s*\$1\s+OR\s+workspace_id\s*=\s*\$1\s*\))(?:\s+AND\s+([\s\S]+?))?(?:\s+ORDER\s+BY|\s+LIMIT|$)/i);
      const extraWhere = wherePartMatch && wherePartMatch[1] ? wherePartMatch[1].trim() : '';

      if (extraWhere) {
        const andClauses = extraWhere.startsWith('(') && extraWhere.endsWith(')')
          ? [extraWhere.slice(1, -1)]
          : extraWhere.split(/\s+AND\s+/i);

        filtered = filtered.filter((row) =>
          andClauses.every((c) => evaluateUniversalCondition(c, row, params))
        );
      }

      return { rows: filtered.map((r) => ({ ...r })), rowCount: filtered.length };
    }

    // 8. UPDATE <table> SET ... WHERE business_id = $1 AND id = ANY($2::uuid[])
    const updateMatch = rawSql.match(/UPDATE\s+["']?([a-z0-9_]+)["']?\s+SET\s+([\s\S]+?)\s+WHERE/i);
    if (updateMatch) {
      const tableName = updateMatch[1].toLowerCase();
      const assignBody = updateMatch[2];
      const assignments = assignBody.split(',').map((s) => s.trim());
      const bizId = params[0];
      const targetIds = params[1] || [];

      const rows = tables.get(tableName) || [];
      const updated = [];
      for (const row of rows) {
        if (row.business_id === bizId && targetIds.includes(row.id)) {
          for (const a of assignments) {
            applyUniversalAssignment(a, row, params);
          }
          row.updated_at = nextIsoTimestamp();
          updated.push({ ...row });
        }
      }
      return { rows: updated, rowCount: updated.length };
    }

    // 9. DELETE FROM <table> WHERE business_id = $1 AND id = ANY($2::uuid[])
    const deleteMatch = rawSql.match(/DELETE\s+FROM\s+["']?([a-z0-9_]+)["']?\s+WHERE\s+(?:business_id\s*=\s*\$1|\(\s*business_id\s*=\s*\$1\s+OR\s+workspace_id\s*=\s*\$1\s*\))\s+AND\s+id\s*=\s*ANY/i);
    if (deleteMatch) {
      const tableName = deleteMatch[1].toLowerCase();
      const bizId = params[0];
      const targetIds = params[1] || [];
      const rows = tables.get(tableName) || [];
      const deleted = [];
      const remaining = rows.filter((r) => {
        if (r.business_id === bizId && targetIds.includes(r.id)) {
          deleted.push({ ...r });
          return false;
        }
        return true;
      });
      tables.set(tableName, remaining);
      return { rows: deleted, rowCount: deleted.length };
    }

    throw new Error(`Unsupported SQL in universal test pool: ${rawSql}`);
  }

  return {
    getQueryLog() {
      return [...queryLog];
    },
    clearQueryLog() {
      queryLog.length = 0;
    },
    async query(sql, params) {
      return executeQuery(sql, params);
    },
    async connect() {
      let snapshot = null;
      return {
        async query(sql, params) {
          const cmd = sql.trim().toUpperCase();
          if (cmd === 'BEGIN') {
            snapshot = cloneState();
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'COMMIT') {
            snapshot = null;
            return { rows: [], rowCount: 0 };
          }
          if (cmd === 'ROLLBACK') {
            if (snapshot) {
              restoreState(snapshot);
              snapshot = null;
            }
            return { rows: [], rowCount: 0 };
          }
          return executeQuery(sql, params);
        },
        release() {},
      };
    },
    setTableRows(name, rows) {
      tables.set(name.toLowerCase(), rows);
    },
    getTableRows(name) {
      return tables.get(name.toLowerCase()) || [];
    },
  };
}

describe('Universal Business Inventory Editor — Dynamic Discovery & Multi-Schema Mutations', () => {
  let server;
  let baseUrl;
  let universalPool;
  const businessId = '684a8863-5094-4c8b-9b15-c50c06335b7f';

  function resetAllTables() {
    // 1. Seed Products (Apparel)
    universalPool.setTableRows('products', [
      {
        id: '11111111-1111-4111-8111-111111111111',
        business_id: businessId,
        name: 'Stripe Shirt',
        category: 'shirt',
        price: 1500,
        discount: 10,
        ordered: 1,
        best: false,
        color: 'Blue, White',
        size: JSON.stringify({ M: 4, L: 6, XL: 2 }),
      },
      {
        id: '11111111-1111-4111-8111-111111111112',
        business_id: businessId,
        name: 'Summer Breeze Shirt',
        category: 'summer shirt',
        price: 1200,
        discount: 20,
        ordered: 3,
        best: false,
        color: 'Yellow',
        size: JSON.stringify({ S: 2, M: 5, L: 4 }),
      },
      {
        id: '11111111-1111-4111-8111-111111111113',
        business_id: businessId,
        name: 'Nightfall Oxford Shirt',
        category: 'formal shirt',
        price: 1800,
        discount: 15,
        ordered: 2,
        best: false,
        color: 'Black',
        size: JSON.stringify({ M: 2, L: 5, XL: 3 }),
      },
    ]);

    // 2. Seed Electronics Inventory
    universalPool.setTableRows('electronics_inventory', [
      {
        id: '22222222-2222-4222-8222-222222222221',
        business_id: businessId,
        Product_Name: 'ROG Strix G16',
        Brand_Name: 'Asus',
        Model: 'G614JU',
        Current_Price: 1350,
        Stock_Qty: 8,
        Warehouse: 'Dhaka',
        Reorder_Level: 10,
        Warranty_Months: 12,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        business_id: businessId,
        Product_Name: 'Zenbook 14',
        Brand_Name: 'Asus',
        Model: 'UX3405',
        Current_Price: 1100,
        Stock_Qty: 15,
        Warehouse: 'Chittagong',
        Reorder_Level: 10,
        Warranty_Months: 12,
      },
      {
        id: '22222222-2222-4222-8222-222222222223',
        business_id: businessId,
        Product_Name: 'XPS 15 Laptop',
        Brand_Name: 'Dell',
        Model: '9530 Laptop',
        Current_Price: 1800,
        Stock_Qty: 5,
        Warehouse: 'Dhaka',
        Reorder_Level: 10,
        Warranty_Months: 12,
      },
      {
        id: '22222222-2222-4222-8222-222222222224',
        business_id: businessId,
        Product_Name: 'Inspiron 16 Laptop',
        Brand_Name: 'Dell',
        Model: '5630 Laptop',
        Current_Price: 950,
        Stock_Qty: 12,
        Warehouse: 'Dhaka',
        Reorder_Level: 10,
        Warranty_Months: 12,
      },
    ]);

    // 3. Seed Grocery Inventory
    universalPool.setTableRows('grocery_inventory', [
      {
        id: '33333333-3333-4333-8333-333333333331',
        business_id: businessId,
        Item_Name: 'Organic Whole Milk',
        Supplier: 'Acme',
        Unit_Cost: 40,
        Selling_Price: 75,
        Expiry_Date: '2026-11-15',
        Batch_No: 'BAT-001',
        Quantity: 50,
        Warehouse_Location: 'Dhaka',
        Status: 'in_stock',
      },
      {
        id: '33333333-3333-4333-8333-333333333332',
        business_id: businessId,
        Item_Name: 'Cheddar Cheese Block',
        Supplier: 'Acme',
        Unit_Cost: 120,
        Selling_Price: 210,
        Expiry_Date: '2026-12-20',
        Batch_No: 'BAT-002',
        Quantity: 30,
        Warehouse_Location: 'Chittagong',
        Status: 'in_stock',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        business_id: businessId,
        Item_Name: 'Greek Yogurt Tub',
        Supplier: 'NorthStar',
        Unit_Cost: 55,
        Selling_Price: 95,
        Expiry_Date: '2027-04-10',
        Batch_No: 'BAT-003',
        Quantity: 45,
        Warehouse_Location: 'Dhaka',
        Status: 'in_stock',
      },
    ]);
  }

  before(async () => {
    universalPool = createUniversalSheetPool();
    setPool(universalPool);
    resetAllTables();

    // Mock LLM generation simulating Gemini's universal interpretation across schemas
    setSheetGeminiGenerator(async (promptText) => {
      const match = promptText.match(/<user_message>([\s\S]*?)<\/user_message>/i);
      const userMsg = (match ? match[1] : promptText).trim();
      const lower = userMsg.toLowerCase();

      if (lower.includes('increase stock for all available sizes of full shirts by 10')) {
        return {
          status: 'ok',
          entity: 'nested_map_test',
          operation: 'update_many',
          filter_logic: 'AND',
          target_filters: [
            { field: 'category', operator: 'equals', value: 'full shirt' },
          ],
          updates: [
            {
              field: 'size',
              action: 'add_to_existing_values',
              value: 10,
              unit: 'absolute',
              key_policy: 'existing_keys_only',
              keys: ['2XL', 'XXXL'],
            },
          ],
        };
      }

      // --- Schema A: Apparel (products) ---
      // Prompt 1: "Increase the price of Stripe Shirt by $10."
      if (lower.includes('price of stripe shirt by $10') || lower.includes('price of stripe shirt by 10')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'update',
          target_filters: [{ field: 'name', operator: 'equals', value: 'Stripe Shirt' }],
          updates: [{ field: 'price', action: 'add', value: 10, unit: 'absolute' }],
        };
      }

      // Prompt 2: "Mark all summer shirts as best sellers."
      if (lower.includes('all summer shirts as best sellers') || lower.includes('summer shirts as best')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'update_many',
          target_filters: [{ field: 'category', operator: 'equals', value: 'summer shirt' }],
          updates: [{ field: 'best', action: 'set', value: true, unit: 'absolute' }],
        };
      }

      // Prompt 3: "Increase the stock of size XL by 3 for all black shirts."
      if (lower.includes('stock of size xl by 3') && lower.includes('black')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'update_many',
          target_filters: [{ field: 'color', operator: 'contains', value: 'Black' }],
          updates: [{ field: 'size.XL', action: 'add', value: 3, unit: 'absolute' }],
        };
      }

      // --- Schema B: Electronics (electronics_inventory) ---
      // Prompt 4: "Put a 10% discount on all products from Asus."
      // In electronics schema, there is Current_Price but no discount column -> reduces Current_Price by 10%
      if (lower.includes('10% discount on all products from asus') || (lower.includes('discount') && lower.includes('asus'))) {
        return {
          status: 'ok',
          entity: 'electronics_inventory',
          operation: 'update_many',
          target_filters: [{ field: 'Brand_Name', operator: 'equals', value: 'Asus' }],
          updates: [{ field: 'Current_Price', action: 'subtract', value: 10, unit: 'percentage' }],
        };
      }

      // Prompt 5: "Increase the reorder level to 20 for products with less than 10 units in stock."
      if (lower.includes('reorder level to 20') && lower.includes('less than 10')) {
        return {
          status: 'ok',
          entity: 'electronics_inventory',
          operation: 'update_many',
          target_filters: [{ field: 'Stock_Qty', operator: 'less_than', value: 10 }],
          updates: [{ field: 'Reorder_Level', action: 'set', value: 20, unit: 'absolute' }],
        };
      }

      // Prompt 6: "Set the warranty period to 24 months for all Dell laptops."
      if (lower.includes('warranty period to 24 months') && lower.includes('dell')) {
        return {
          status: 'ok',
          entity: 'electronics_inventory',
          operation: 'update_many',
          target_filters: [
            { field: 'Brand_Name', operator: 'equals', value: 'Dell' },
            { field: 'Model', operator: 'contains', value: 'Laptop' },
          ],
          updates: [{ field: 'Warranty_Months', action: 'set', value: 24, unit: 'absolute' }],
        };
      }

      // Prompt 7: "Increase the price of all products stored in Dhaka warehouse by 5%."
      if (lower.includes('price of all products stored in dhaka warehouse by 5%') || (lower.includes('dhaka warehouse') && lower.includes('5%'))) {
        return {
          status: 'ok',
          entity: 'electronics_inventory',
          operation: 'update_many',
          target_filters: [{ field: 'Warehouse', operator: 'equals', value: 'Dhaka' }],
          updates: [{ field: 'Current_Price', action: 'add', value: 5, unit: 'percentage' }],
        };
      }

      // --- Schema C: Grocery (grocery_inventory) ---
      // Prompt 8: "Reduce the selling price of products from supplier Acme by 50."
      // Modifies Selling_Price, NOT Unit_Cost
      if (lower.includes('selling price of products from supplier acme by 50') || (lower.includes('selling price') && lower.includes('acme') && lower.includes('50'))) {
        return {
          status: 'ok',
          entity: 'grocery_inventory',
          operation: 'update_many',
          target_filters: [{ field: 'Supplier', operator: 'equals', value: 'Acme' }],
          updates: [{ field: 'Selling_Price', action: 'subtract', value: 50, unit: 'absolute' }],
        };
      }

      // Prompt 9: "Mark items expiring before January 1, 2027 as clearance."
      if (lower.includes('expiring before january 1, 2027 as clearance') || (lower.includes('2027') && lower.includes('clearance'))) {
        return {
          status: 'ok',
          entity: 'grocery_inventory',
          operation: 'update_many',
          target_filters: [{ field: 'Expiry_Date', operator: 'less_than', value: '2027-01-01' }],
          updates: [{ field: 'Status', action: 'set', value: 'clearance', unit: 'absolute' }],
        };
      }

      // Prompt 10: "Increase the quantity of products in warehouse Dhaka by 15 units."
      if (lower.includes('quantity of products in warehouse dhaka by 15') || (lower.includes('dhaka') && lower.includes('quantity') && lower.includes('15'))) {
        return {
          status: 'ok',
          entity: 'grocery_inventory',
          operation: 'update_many',
          target_filters: [{ field: 'Warehouse_Location', operator: 'equals', value: 'Dhaka' }],
          updates: [{ field: 'Quantity', action: 'add', value: 15, unit: 'absolute' }],
        };
      }

      // Prompt 11: "Reduce the unit cost of products from supplier NorthStar by 5%."
      // User explicitly mentioned "unit cost" -> modifies Unit_Cost
      if (lower.includes('unit cost of products from supplier northstar by 5%') || (lower.includes('unit cost') && lower.includes('northstar') && lower.includes('5%'))) {
        return {
          status: 'ok',
          entity: 'grocery_inventory',
          operation: 'update_many',
          target_filters: [{ field: 'Supplier', operator: 'equals', value: 'NorthStar' }],
          updates: [{ field: 'Unit_Cost', action: 'subtract', value: 5, unit: 'percentage' }],
        };
      }

      // Ambiguity or nonexistent column
      if (lower.includes('warranty') && promptText.includes('Table: grocery_inventory')) {
        return {
          status: 'clarification_needed',
          message: 'The field "warranty" does not exist in the grocery_inventory schema.',
          entity: 'grocery_inventory',
          operation: null,
          filters: [],
        };
      }

      return {
        status: 'clarification_needed',
        message: 'Could not clearly resolve requested inventory operation.',
        entity: 'products',
        operation: null,
        filters: [],
      };
    });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ==========================================
  // Section 1: Dynamic Schema Discovery Tests
  // ==========================================
  it('1. Dynamically discovers schemas and injects active table columns and representative values into Gemini prompt', async () => {
    // 1. Electronics schema discovery
    const elecSchema = await discoverTableSchema('electronics_inventory', businessId);
    assert.equal(elecSchema.entity, 'electronics_inventory');
    assert.ok(elecSchema.columns.product_name);
    assert.ok(elecSchema.columns.current_price);
    assert.ok(elecSchema.columns.stock_qty);
    assert.ok(elecSchema.columns.warehouse);
    assert.ok(elecSchema.columns.warranty_months);

    const elecPrompt = buildSheetQueryPrompt({
      entity: 'electronics_inventory',
      schema: elecSchema,
      message: 'Put a 10% discount on all products from Asus.',
      isMutation: true,
    });
    assert.ok(elecPrompt.includes('ACTIVE TABLE SCHEMA'));
    assert.ok(elecPrompt.includes('Table: electronics_inventory'));
    assert.ok(elecPrompt.includes('Product_Name (string)'));
    assert.ok(elecPrompt.includes('Current_Price (number)'));
    assert.ok(elecPrompt.includes('Warehouse (string)'));
    assert.ok(elecPrompt.includes('Representative values'));
    assert.ok(elecPrompt.includes('"Dhaka", "Chittagong"'));
    // Should NOT include apparel nested size keys since electronics has no size column
    assert.ok(!elecPrompt.includes('SPECIAL NESTED SIZE FIELDS'));

    // 2. Grocery schema discovery
    const grocSchema = await discoverTableSchema('grocery_inventory', businessId);
    assert.equal(grocSchema.entity, 'grocery_inventory');
    assert.ok(grocSchema.columns.item_name);
    assert.ok(grocSchema.columns.supplier);
    assert.ok(grocSchema.columns.unit_cost);
    assert.ok(grocSchema.columns.selling_price);
    assert.ok(grocSchema.columns.expiry_date);
    assert.ok(grocSchema.columns.quantity);

    const grocPrompt = buildSheetQueryPrompt({
      entity: 'grocery_inventory',
      schema: grocSchema,
      message: 'Reduce the selling price of products from supplier Acme by 50.',
      isMutation: true,
    });
    assert.ok(grocPrompt.includes('Table: grocery_inventory'));
    assert.ok(grocPrompt.includes('Item_Name (string)'));
    assert.ok(grocPrompt.includes('Selling_Price (number)'));
    assert.ok(grocPrompt.includes('Unit_Cost (number)'));
    assert.ok(grocPrompt.includes('"Acme", "NorthStar"'));
  });

  // ==========================================
  // Section 2: Schema A Demonstrations (Apparel)
  // ==========================================
  it('2. Schema A Prompt 1: "Increase the price of Stripe Shirt by $10."', async () => {
    resetAllTables();

    // Preview
    const prevRes = await fetch(`${baseUrl}/api/sheets/products/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Increase the price of Stripe Shirt by $10.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    assert.equal(prev.affected_count, 1);
    assert.equal(prev.diff[0].before.price, 1500);
    assert.equal(prev.diff[0].after.price, 1510);

    // Execute
    const execRes = await fetch(`${baseUrl}/api/sheets/products/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Increase the price of Stripe Shirt by $10.',
        confirm: true,
        preview_hash: prev.preview_hash,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    assert.equal(exec.updated_rows[0].price, 1510);
  });

  it('3. Schema A Prompt 2: "Mark all summer shirts as best sellers."', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/products/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Mark all summer shirts as best sellers.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    assert.equal(prev.affected_count, 1);
    assert.equal(prev.diff[0].before.best, false);
    assert.equal(prev.diff[0].after.best, true);

    const execRes = await fetch(`${baseUrl}/api/sheets/products/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Mark all summer shirts as best sellers.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    assert.equal(exec.updated_rows[0].best, true);
  });

  it('4. Schema A Prompt 3: "Increase the stock of size XL by 3 for all black shirts."', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/products/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Increase the stock of size XL by 3 for all black shirts.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    assert.equal(prev.affected_count, 1);
    assert.equal(prev.diff[0].before['size.XL'], 3);
    assert.equal(prev.diff[0].after['size.XL'], 6);

    const execRes = await fetch(`${baseUrl}/api/sheets/products/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Increase the stock of size XL by 3 for all black shirts.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    const parsedSize = JSON.parse(exec.updated_rows[0].size);
    assert.equal(parsedSize.XL, 6);
  });

  // ==========================================
  // Section 3: Schema B Demonstrations (Electronics)
  // ==========================================
  it('5. Schema B Prompt 4: "Put a 10% discount on all products from Asus."', async () => {
    resetAllTables();

    // Electronics table has no discount column, so discount is applied to Current_Price (-10%)
    const prevRes = await fetch(`${baseUrl}/api/sheets/electronics_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'electronics_inventory',
        message: 'Put a 10% discount on all products from Asus.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    assert.equal(prev.affected_count, 2); // ROG Strix G16 (1350 -> 1215), Zenbook 14 (1100 -> 990)

    const rog = prev.diff.find((d) => d.name === 'ROG Strix G16');
    assert.ok(rog);
    assert.equal(rog.before.Current_Price, 1350);
    assert.equal(rog.after.Current_Price, 1215);

    const zen = prev.diff.find((d) => d.name === 'Zenbook 14');
    assert.ok(zen);
    assert.equal(zen.before.Current_Price, 1100);
    assert.equal(zen.after.Current_Price, 990);

    // Execute
    const execRes = await fetch(`${baseUrl}/api/sheets/electronics_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'electronics_inventory',
        message: 'Put a 10% discount on all products from Asus.',
        confirm: true,
        preview_hash: prev.preview_hash,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    assert.equal(exec.affected_count, 2);
    const updatedRog = exec.updated_rows.find((r) => r.Product_Name === 'ROG Strix G16');
    assert.equal(updatedRog.Current_Price, 1215);
  });

  it('6. Schema B Prompt 5: "Increase the reorder level to 20 for products with less than 10 units in stock."', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/electronics_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'electronics_inventory',
        message: 'Increase the reorder level to 20 for products with less than 10 units in stock.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    // ROG Strix (stock 8) and XPS 15 (stock 5) and Spectre x360 (stock 6)
    assert.equal(prev.affected_count, 2); // In our seed: ROG Strix (8), XPS 15 (5)
    for (const d of prev.diff) {
      assert.equal(d.before.Reorder_Level, 10);
      assert.equal(d.after.Reorder_Level, 20);
    }

    const execRes = await fetch(`${baseUrl}/api/sheets/electronics_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'electronics_inventory',
        message: 'Increase the reorder level to 20 for products with less than 10 units in stock.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    for (const r of exec.updated_rows) {
      assert.equal(r.Reorder_Level, 20);
    }
  });

  it('7. Schema B Prompt 6: "Set the warranty period to 24 months for all Dell laptops."', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/electronics_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'electronics_inventory',
        message: 'Set the warranty period to 24 months for all Dell laptops.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    assert.equal(prev.affected_count, 2); // XPS 15 Laptop and Inspiron 16 Laptop
    for (const d of prev.diff) {
      assert.equal(d.before.Warranty_Months, 12);
      assert.equal(d.after.Warranty_Months, 24);
    }

    const execRes = await fetch(`${baseUrl}/api/sheets/electronics_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'electronics_inventory',
        message: 'Set the warranty period to 24 months for all Dell laptops.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    assert.equal(exec.affected_count, 2);
    for (const r of exec.updated_rows) {
      assert.equal(r.Warranty_Months, 24);
    }
  });

  it('8. Schema B Prompt 7: "Increase the price of all products stored in Dhaka warehouse by 5%."', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/electronics_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'electronics_inventory',
        message: 'Increase the price of all products stored in Dhaka warehouse by 5%.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    assert.equal(prev.affected_count, 3); // ROG Strix G16 (1350 -> 1417.50), XPS 15 (1800 -> 1890), Inspiron 16 (950 -> 997.50)

    const xps = prev.diff.find((d) => d.name === 'XPS 15 Laptop');
    assert.ok(xps);
    assert.equal(xps.before.Current_Price, 1800);
    assert.equal(xps.after.Current_Price, 1890);

    const execRes = await fetch(`${baseUrl}/api/sheets/electronics_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'electronics_inventory',
        message: 'Increase the price of all products stored in Dhaka warehouse by 5%.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    const updatedXps = exec.updated_rows.find((r) => r.Product_Name === 'XPS 15 Laptop');
    assert.equal(updatedXps.Current_Price, 1890);
  });

  // ==========================================
  // Section 4: Schema C Demonstrations (Grocery)
  // ==========================================
  it('9. Schema C Prompt 8: "Reduce the selling price of products from supplier Acme by 50." (leaves Unit_Cost unchanged)', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Reduce the selling price of products from supplier Acme by 50.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    assert.equal(prev.affected_count, 2); // Organic Whole Milk (75 -> 25) & Cheddar Cheese (210 -> 160)

    const milk = prev.diff.find((d) => d.name === 'Organic Whole Milk');
    assert.ok(milk);
    assert.equal(milk.before.Selling_Price, 75);
    assert.equal(milk.after.Selling_Price, 25);
    // Crucial invariant: Unit_Cost was NOT modified!
    assert.equal(milk.before.Unit_Cost, undefined);

    const execRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Reduce the selling price of products from supplier Acme by 50.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    const updatedMilk = exec.updated_rows.find((r) => r.Item_Name === 'Organic Whole Milk');
    assert.equal(updatedMilk.Selling_Price, 25);
    assert.equal(updatedMilk.Unit_Cost, 40); // Preserved!
  });

  it('10. Schema C Prompt 9: "Mark items expiring before January 1, 2027 as clearance."', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Mark items expiring before January 1, 2027 as clearance.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    // Organic Milk (2026-11-15) & Cheddar Cheese (2026-12-20) expire before 2027-01-01
    assert.equal(prev.affected_count, 2);
    for (const d of prev.diff) {
      assert.equal(d.before.Status, 'in_stock');
      assert.equal(d.after.Status, 'clearance');
    }

    const execRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Mark items expiring before January 1, 2027 as clearance.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    for (const r of exec.updated_rows) {
      assert.equal(r.Status, 'clearance');
    }
  });

  it('11. Schema C Prompt 10: "Increase the quantity of products in warehouse Dhaka by 15 units."', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Increase the quantity of products in warehouse Dhaka by 15 units.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    // Organic Milk (Dhaka, 50 -> 65) & Greek Yogurt (Dhaka, 45 -> 60)
    assert.equal(prev.affected_count, 2);

    const milk = prev.diff.find((d) => d.name === 'Organic Whole Milk');
    assert.equal(milk.before.Quantity, 50);
    assert.equal(milk.after.Quantity, 65);

    const execRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Increase the quantity of products in warehouse Dhaka by 15 units.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    const updatedMilk = exec.updated_rows.find((r) => r.Item_Name === 'Organic Whole Milk');
    assert.equal(updatedMilk.Quantity, 65);
  });

  it('12. Schema C Prompt 11: "Reduce the unit cost of products from supplier NorthStar by 5%." (leaves Selling_Price unchanged)', async () => {
    resetAllTables();

    const prevRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Reduce the unit cost of products from supplier NorthStar by 5%.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prev = await prevRes.json();
    assert.equal(prev.status, 'preview');
    assert.equal(prev.affected_count, 1); // Greek Yogurt (NorthStar, Unit_Cost 55 -> 52.25)

    const yogurt = prev.diff[0];
    assert.equal(yogurt.before.Unit_Cost, 55);
    assert.equal(yogurt.after.Unit_Cost, 52.25);
    // Crucial invariant: Selling_Price was NOT modified!
    assert.equal(yogurt.before.Selling_Price, undefined);

    const execRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Reduce the unit cost of products from supplier NorthStar by 5%.',
        confirm: true,
      }),
    });
    assert.equal(execRes.status, 200);
    const exec = await execRes.json();
    assert.equal(exec.status, 'success');
    const updatedYogurt = exec.updated_rows[0];
    assert.equal(updatedYogurt.Unit_Cost, 52.25);
    assert.equal(updatedYogurt.Selling_Price, 95); // Preserved!
  });

  // ==========================================
  // Section 5: Ambiguity & Missing Column Tests
  // ==========================================
  it('13. Returns status: "clarification_needed" when requesting unsupported column on active table', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/grocery_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'grocery_inventory',
        message: 'Increase the warranty of all milk by 6 months.',
        confirm: false,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'clarification_needed');
    assert.ok(body.message.includes('warranty'));
  });

  it('14. Uploading CSV to any entity sheet replaces records cleanly without duplicates', async () => {
    const csvContent = [
      'Product_Name,Brand_Name,Model,Current_Price,Stock_Qty,Warehouse,Reorder_Level,Warranty_Months',
      'Blade 16,Razer,RZ09,2400.00,3,Dhaka,5,12',
      'Surface Laptop 6,Microsoft,1951,1300.00,7,Chittagong,10,12',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([csvContent], { type: 'text/csv' }), 'electronics_replacement.csv');

    const res = await fetch(`${baseUrl}/api/sheets/electronics_inventory/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.imported_count, 2);

    const stored = universalPool.getTableRows('electronics_inventory').filter((r) => r.business_id === businessId);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].Product_Name, 'Blade 16');
  });

  it('15. Uploading CSV with different fields to /api/sheets/upload auto-detects schema without requiring fixed product columns', async () => {
    const groceryCsv = [
      'Item_Name,Supplier,Unit_Cost,Selling_Price,Expiry_Date,Batch_No,Quantity,Warehouse_Location,Status',
      'Organic Butter,DairyPure,80.00,120.00,2026-12-31,BAT-999,25,Dhaka,in_stock',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([groceryCsv], { type: 'text/csv' }), 'grocery_inventory.csv');

    // User hits /api/sheets/upload (or legacy products endpoint) with a different schema CSV
    const res = await fetch(`${baseUrl}/api/sheets/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entity, 'grocery_inventory');
    assert.equal(body.imported_count, 1);

    const stored = universalPool.getTableRows('grocery_inventory').filter((r) => r.business_id === businessId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].Item_Name, 'Organic Butter');
  });

  it('16. "Add Rows" (append mode) appends new rows to existing active sheet when columns match', async () => {
    // Current electronics has 2 items from test 14 (Blade 16, Surface Laptop 6)
    const appendCsv = [
      'Product_Name,Brand_Name,Model,Current_Price,Stock_Qty,Warehouse,Reorder_Level,Warranty_Months',
      'ThinkPad X1 Carbon,Lenovo,Gen 11,1950.00,4,Dhaka,8,36',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([appendCsv], { type: 'text/csv' }), 'add_laptop.csv');

    const res = await fetch(`${baseUrl}/api/sheets/electronics_inventory/append?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'append');
    assert.equal(body.imported_count, 1);

    // Existing rows preserved + new row appended!
    const stored = universalPool.getTableRows('electronics_inventory').filter((r) => r.business_id === businessId);
    assert.equal(stored.length, 3);
    assert.ok(stored.some((r) => r.Product_Name === 'ThinkPad X1 Carbon'));
    assert.ok(stored.some((r) => r.Product_Name === 'Blade 16'));
  });

  it('17. "Add Rows" (append mode) rejects upload when columns do not match the active sheet', async () => {
    // Mismatched CSV: wrong headers (grocery headers uploaded into electronics active sheet)
    const mismatchedCsv = [
      'Item_Name,Supplier,Unit_Cost,Selling_Price',
      'Organic Butter,DairyPure,80.00,120.00',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([mismatchedCsv], { type: 'text/csv' }), 'wrong_columns.csv');

    const res = await fetch(`${baseUrl}/api/sheets/electronics_inventory/append?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('columns do not match active sheet'));
    assert.ok(body.error.includes('Product_Name'));
  });

  it('18. Uploading an arbitrary custom CSV dynamically creates table on-demand without requiring "npm run db:init"', async () => {
    const pharmacyCsv = [
      'Med_Name,Dosage,Stock_Count,Unit_Price,Prescription_Required',
      'Paracetamol,500mg,100,5.50,false',
      'Amoxicillin,250mg,40,18.00,true',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([pharmacyCsv], { type: 'text/csv' }), 'pharmacy_medicines.csv');

    const res = await fetch(`${baseUrl}/api/sheets/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entity, 'pharmacy_medicines');
    assert.equal(body.imported_count, 2);

    // Verify stored rows in the dynamically created table
    const stored = universalPool.getTableRows('pharmacy_medicines').filter((r) => r.business_id === businessId);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].Med_Name, 'Paracetamol');
    assert.equal(stored[1].Med_Name, 'Amoxicillin');
  });

  it('19. Calling GET /api/sheets/:entity on an uninitialized sheet auto-creates table and returns 200 with empty rows rather than failing with 42P01', async () => {
    const res = await fetch(`${baseUrl}/api/sheets/grocery_inventory?businessId=${businessId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.entity, 'grocery_inventory');
    assert.ok(Array.isArray(body.rows));
  });

  it('20. Uploads handbag_inventory.csv with mixed-case columns, resolves without 42703 column errors, and supports NL queries and mutations', async () => {
    const handbagCsv = [
      'Product_Model,Vendor,Cost_Price,Retail_Price,Collection_Season,SKU,Units_In_Stock,Distribution_Center,Is_Available',
      'Classic Quilted Shoulder Bag,Bellavita Leather,1200.00,2499.00,SS-2026,HB-QST-001,18,Dhaka Central,true',
      'Saffiano Leather Tote,ModaSole,1850.00,3800.00,AW-2026,HB-SFT-002,25,Chittagong Port,true',
      'Minimalist Vegan Crossbody,UrbanEco Studio,750.00,1550.00,SS-2026,HB-VXC-003,0,Dhaka Central,false',
      'Croc-Embossed Evening Clutch,Atelier Luxe,980.00,2100.00,AW-2026,HB-CEC-004,12,Sylhet Depot,true',
      'Canvas Everyday Satchel,CraftHouse Goods,550.00,1150.00,SS-2026,HB-CES-005,0,Chittagong Port,false',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([handbagCsv], { type: 'text/csv' }), 'handbag_inventory.csv');

    // Upload via /api/sheets/upload or /api/sheets/handbag_inventory/upload
    const res = await fetch(`${baseUrl}/api/sheets/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entity, 'handbag_inventory');
    assert.equal(body.imported_count, 5);
    assert.equal(body.source_file, 'handbag_inventory.csv');

    // Verify GET /api/sheets/handbag_inventory
    const getRes = await fetch(`${baseUrl}/api/sheets/handbag_inventory?businessId=${businessId}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.rows.length, 5);
    assert.equal(getBody.rows[0].Product_Model, 'Classic Quilted Shoulder Bag');
    assert.equal(getBody.rows[0].Retail_Price, 2499);

    // Test Natural Language Mutation on the dynamic handbag_inventory table:
    // "Increase the Retail_Price of products with Units_In_Stock greater than 15 by 200."
    setSheetGeminiGenerator(async () => ({
      status: 'ok',
      entity: 'handbag_inventory',
      operation: 'update_many',
      target_filters: [
        { field: 'Units_In_Stock', operator: 'greater_than', value: 15 },
      ],
      updates: [
        { field: 'Retail_Price', action: 'add', value: 200, unit: 'absolute' },
      ],
    }));

    const prevRes = await fetch(`${baseUrl}/api/sheets/handbag_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'handbag_inventory',
        message: 'Increase the Retail_Price of products with Units_In_Stock greater than 15 by 200.',
        confirm: false,
      }),
    });
    assert.equal(prevRes.status, 200);
    const prevBody = await prevRes.json();
    assert.equal(prevBody.status, 'preview');
    assert.equal(prevBody.affected_count, 2); // Classic Quilted (18) and Saffiano (25)

    // Confirm mutation
    const execRes = await fetch(`${baseUrl}/api/sheets/handbag_inventory/mutate?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: 'handbag_inventory',
        message: 'Increase the Retail_Price of products with Units_In_Stock greater than 15 by 200.',
        confirm: true,
        preview_hash: prevBody.preview_hash,
      }),
    });
    assert.equal(execRes.status, 200);
    const execBody = await execRes.json();
    assert.equal(execBody.status, 'success');
    assert.equal(execBody.affected_count, 2);

    const updatedClassic = execBody.updated_rows.find((r) => r.Product_Model === 'Classic Quilted Shoulder Bag');
    assert.equal(updatedClassic.Retail_Price, 2699); // 2499 + 200
  });

  it('21. Uploads cake_inventory.csv with Stock column and ensures NO imaginary columns (such as Status) are created or returned', async () => {
    const cakeCsv = [
      'Item_Name,Supplier,Unit_Cost,Selling_Price,Expiry_Date,Batch_No,Quantity,Warehouse_Location,Stock',
      'Red Velvet Cake (1kg),SweetBake Supplies,450.00,850.00,2026-11-05,CK-101,15,Dhaka,true',
      'Dark Chocolate Fudge Cake,CocoaCraft,520.00,950.00,2026-11-04,CK-102,20,Chittagong,true',
      'Vanilla Bean Sponge Cake,SweetBake Supplies,350.00,650.00,2026-11-03,CK-103,0,Dhaka,false',
      'Blueberry Cheesecake Slice,Artisan Bakery Co,180.00,320.00,2026-11-02,CK-104,35,Chittagong,true',
      'Salted Caramel Torte,Artisan Bakery Co,480.00,890.00,2026-11-06,CK-105,0,Dhaka,false',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([cakeCsv], { type: 'text/csv' }), 'cake_inventory.csv');

    const uploadRes = await fetch(`${baseUrl}/api/sheets/upload?businessId=${businessId}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(uploadRes.status, 200);
    const uploadBody = await uploadRes.json();

    // Verify entity derived from filename, NOT misclassified as grocery_inventory
    assert.equal(uploadBody.entity, 'cake_inventory');
    assert.equal(uploadBody.displayName, 'Cake Inventory');
    assert.equal(uploadBody.imported_count, 5);

    // Verify returned columns contain Stock and NO imaginary Status column
    assert.ok(Array.isArray(uploadBody.columns));
    assert.ok(uploadBody.columns.includes('Stock'), 'Uploaded columns must include Stock');
    assert.ok(!uploadBody.columns.includes('Status'), 'Uploaded columns must NOT include imaginary Status column');
    assert.ok(!uploadBody.columns.includes('status'), 'Uploaded columns must NOT include imaginary status column');

    // Verify GET /api/sheets/cake_inventory
    const getRes = await fetch(`${baseUrl}/api/sheets/cake_inventory?businessId=${businessId}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.status, 'ok');
    assert.equal(getBody.entity, 'cake_inventory');
    assert.equal(getBody.rows.length, 5);

    // Verify columns array in GET response
    assert.ok(getBody.columns.includes('Stock'));
    assert.ok(!getBody.columns.includes('Status'));
    assert.ok(!getBody.columns.includes('status'));

    // Verify each returned row only contains legitimate columns
    for (const row of getBody.rows) {
      assert.ok('Stock' in row || 'stock' in row, 'Row must contain Stock');
      assert.strictEqual(row.Status, undefined, 'Row must NOT contain imaginary Status property');
      assert.strictEqual(row.status, undefined, 'Row must NOT contain imaginary status property');
    }

    assert.equal(getBody.rows[0].Item_Name, 'Red Velvet Cake (1kg)');
    assert.equal(getBody.rows[0].Stock, true);
    assert.equal(getBody.rows[2].Stock, false);

    // Also verify uploading grocery_inventory.csv with Stock column does NOT leak imaginary Status
    const groceryStockCsv = [
      'Item_Name,Supplier,Unit_Cost,Selling_Price,Expiry_Date,Batch_No,Quantity,Warehouse_Location,Stock',
      'Organic Whole Milk,Acme,40.00,75.00,2026-11-15,BAT-001,50,Dhaka,true',
      'Greek Yogurt Tub,NorthStar,55.00,95.00,2027-04-10,BAT-003,45,Dhaka,false',
    ].join('\n');

    const gForm = new FormData();
    gForm.append('file', new Blob([groceryStockCsv], { type: 'text/csv' }), 'grocery_inventory.csv');

    const gUploadRes = await fetch(`${baseUrl}/api/sheets/upload?businessId=${businessId}`, {
      method: 'POST',
      body: gForm,
    });
    assert.equal(gUploadRes.status, 200);
    const gUploadBody = await gUploadRes.json();
    assert.equal(gUploadBody.entity, 'grocery_inventory');
    assert.ok(gUploadBody.columns.includes('Stock'));
    assert.ok(!gUploadBody.columns.includes('Status'));
    assert.ok(!gUploadBody.columns.includes('status'));

    const gGetRes = await fetch(`${baseUrl}/api/sheets/grocery_inventory?businessId=${businessId}`);
    assert.equal(gGetRes.status, 200);
    const gGetBody = await gGetRes.json();
    assert.equal(gGetBody.rows.length, 2);
    for (const row of gGetBody.rows) {
      assert.strictEqual(row.Status, undefined);
      assert.strictEqual(row.status, undefined);
    }
  });

  it('38. Dynamically inserts single rows with arbitrary columns to active sheet (products and shoe_inventory)', async () => {
    // 1. Insert a row to products
    const addProductRes = await fetch(`${baseUrl}/api/sheets/products/row?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        row: {
          name: 'Oxford Silk Tuxedo Shirt',
          category: 'Formal',
          price: 1850,
          discount: 10,
          color: 'Midnight Blue',
          best: true,
        },
      }),
    });
    assert.equal(addProductRes.status, 201);
    const addProductBody = await addProductRes.json();
    assert.equal(addProductBody.entity, 'products');
    assert.ok(addProductBody.count >= 1);

    // 2. Upload shoe_inventory CSV
    const shoeCsv = [
      'product name,brand,category,price',
      'Air Jordan 1,Nike,Sneakers,180',
      'Ultraboost Light,Adidas,Running,190',
    ].join('\n');

    const shoeForm = new FormData();
    shoeForm.append('file', new Blob([shoeCsv], { type: 'text/csv' }), 'shoe_inventory.csv');
    const uploadShoeRes = await fetch(`${baseUrl}/api/sheets/upload?businessId=${businessId}`, {
      method: 'POST',
      body: shoeForm,
    });
    assert.equal(uploadShoeRes.status, 200);

    // 3. Insert a single new row to shoe_inventory with dynamic columns
    const addShoeRes = await fetch(`${baseUrl}/api/sheets/shoe_inventory/row?businessId=${businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        row: {
          'product name': 'Clifton 9',
          brand: 'Hoka',
          category: 'Road Running',
          price: 145,
        },
      }),
    });
    assert.equal(addShoeRes.status, 201);
    const addShoeBody = await addShoeRes.json();
    assert.equal(addShoeBody.entity, 'shoe_inventory');
    assert.equal(addShoeBody.count, 3);

    // 4. Verify the row was appended to shoe_inventory
    const getShoeRes = await fetch(`${baseUrl}/api/sheets/shoe_inventory?businessId=${businessId}`);
    assert.equal(getShoeRes.status, 200);
    const getShoeBody = await getShoeRes.json();
    assert.equal(getShoeBody.rows.length, 3);
    const hokaRow = getShoeBody.rows.find((r) => r.brand === 'Hoka');
    assert.ok(hokaRow, 'Hoka shoe row must be present');
    assert.equal(hokaRow.product_name || hokaRow['product name'], 'Clifton 9');
    assert.equal(hokaRow.price, 145);
  });

  it('39. Increments only each matching record’s existing nested size keys through preview and confirmation', async () => {
    const mapSchema = {
      entity: 'nested_map_test',
      tableName: 'nested_map_test',
      displayName: 'Nested Map Test',
      columns: {
        id: { exactName: 'id', type: 'uuid', readonly: true, modifiable: false },
        business_id: {
          exactName: 'business_id',
          type: 'uuid',
          readonly: true,
          modifiable: false,
        },
        name: { exactName: 'name', type: 'string', modifiable: true },
        category: { exactName: 'category', type: 'string', modifiable: true },
        size: {
          exactName: 'size',
          type: 'string',
          storageType: 'text',
          nestedMap: true,
          nestedValueType: 'integer',
          description: 'JSON map of size stock entries',
          modifiable: true,
        },
        created_at: {
          exactName: 'created_at',
          type: 'date',
          readonly: true,
          modifiable: false,
        },
        updated_at: {
          exactName: 'updated_at',
          type: 'date',
          readonly: true,
          modifiable: false,
        },
      },
      representativeValues: {},
    };
    registerTableSchema('nested_map_test', mapSchema);
    const records = [
      {
        id: '44444444-4444-4444-8444-444444444441',
        business_id: businessId,
        name: 'Shirt A',
        category: 'full shirt',
        size: JSON.stringify({ M: 3, L: 7, XL: 8 }),
      },
      {
        id: '44444444-4444-4444-8444-444444444442',
        business_id: businessId,
        name: 'Shirt B',
        category: 'full shirt',
        size: JSON.stringify({ M: 2, XXL: 5 }),
      },
      {
        id: '44444444-4444-4444-8444-444444444443',
        business_id: businessId,
        name: 'Other Shirt',
        category: 'short shirt',
        size: JSON.stringify({ S: 1 }),
      },
    ];
    universalPool.setTableRows('nested_map_test', records);

    const message =
      'Increase stock for all available sizes of full shirts by 10. If a size does not exist, do not append it; only add stock to existing sizes.';
    universalPool.clearQueryLog();
    setSheetGeminiGenerator(async () => ({
      status: 'ok',
      entity: 'nested_map_test',
      operation: 'update_many',
      filter_logic: 'AND',
      target_filters: [
        { field: 'category', operator: 'equals', value: 'full shirt' },
      ],
      updates: [
        {
          field: 'size',
          action: 'add_to_existing_values',
          value: 10,
          unit: 'absolute',
          key_policy: 'existing_keys_only',
          keys: ['2XL', 'XXXL'],
        },
      ],
    }));
    const previewResponse = await fetch(
      `${baseUrl}/api/sheets/nested_map_test/mutate?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity: 'nested_map_test', message, confirm: false }),
      }
    );
    const preview = await previewResponse.json();
    assert.equal(preview.status, 'preview', preview.message);
    assert.equal(preview.affected_count, 2);
    const previewQueries = universalPool.getQueryLog();
    assert.equal(
      previewQueries.filter(({ sql }) =>
        /^\s*SELECT column_name, data_type, udt_name, is_nullable/i.test(sql)
      ).length,
      1,
      'preview should introspect the active schema only once'
    );
    assert.equal(
      previewQueries.filter(({ sql }) =>
        /FROM "nested_map_test" WHERE business_id = \$1 LIMIT 5/i.test(sql)
      ).length,
      1,
      'preview should sample the active schema only once'
    );
    assert.equal(
      previewQueries.filter(({ sql }) =>
        /SELECT 1 FROM information_schema\.tables/i.test(sql)
      ).length,
      1,
      'preview should check table existence only once'
    );
    assert.equal(
      previewQueries.filter(({ sql }) =>
        /SELECT column_name FROM information_schema\.columns/i.test(sql)
      ).length,
      1,
      'preview should synchronize table columns only once'
    );
    const catalogQueries = previewQueries.filter(({ sql }) =>
      /^\s*SELECT DISTINCT/i.test(sql)
    );
    assert.equal(
      catalogQueries.length,
      0,
      'compact table-local mutation prompt should rely on the active schema profile, not catalog scans'
    );
    assert.deepEqual(preview.approved_mutation.target_filters, [
      { field: 'category', operator: 'equals', value: 'full shirt' },
    ]);
    assert.deepEqual(preview.approved_mutation.updates[0], {
      field: 'size',
      nested_field: 'size',
      action: 'add_to_existing_values',
      value: 10,
      unit: 'absolute',
      key_policy: 'existing_keys_only',
    });

    const previewA = preview.diff.find((row) => row.name === 'Shirt A');
    const previewB = preview.diff.find((row) => row.name === 'Shirt B');
    assert.deepEqual(JSON.parse(previewA.after.size), { M: 13, L: 17, XL: 18 });
    assert.deepEqual(JSON.parse(previewB.after.size), { M: 12, XXL: 15 });

    const executeResponse = await fetch(
      `${baseUrl}/api/sheets/nested_map_test/mutate?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'nested_map_test',
          mutation: preview.approved_mutation,
          expected_preview_hash: preview.preview_hash,
          confirm: true,
        }),
      }
    );
    const execution = await executeResponse.json();
    assert.equal(execution.status, 'success');
    assert.equal(execution.affected_count, 2);

    const finalRows = universalPool.getTableRows('nested_map_test');
    const finalA = JSON.parse(finalRows.find((row) => row.name === 'Shirt A').size);
    const finalB = JSON.parse(finalRows.find((row) => row.name === 'Shirt B').size);
    assert.deepEqual(finalA, { M: 13, L: 17, XL: 18 });
    assert.deepEqual(finalB, { M: 12, XXL: 15 });
    assert.ok(!Object.hasOwn(finalA, '2XL'));
    assert.ok(!Object.hasOwn(finalB, '2XL'));
    assert.deepEqual(
      JSON.parse(finalRows.find((row) => row.name === 'Other Shirt').size),
      { S: 1 }
    );
  });

  it('40. Preserves JSONB object storage and ignores injected missing keys in existing-entry operations', () => {
    const baseSchema = getSchema('products');
    const jsonbSchema = {
      ...baseSchema,
      columns: {
        ...baseSchema.columns,
        size: {
          ...baseSchema.columns.size,
          type: 'json',
          storageType: 'jsonb',
          nestedMap: true,
          nestedValueType: 'integer',
        },
      },
    };
    const validated = validateMutation(jsonbSchema, {
      operation: 'update_many',
      target_filters: [
        { field: 'category', operator: 'equals', value: 'full shirt' },
      ],
      updates: [
        {
          field: 'size',
          action: 'add_to_existing_values',
          value: 10,
          unit: 'absolute',
          key_policy: 'existing_keys_only',
          keys: ['2XL', 'XXXL'],
        },
      ],
    });
    const row = {
      id: '55555555-5555-4555-8555-555555555551',
      business_id: businessId,
      name: 'JSONB shirt',
      category: 'full shirt',
      size: { M: 3, XXL: 5 },
    };
    const computed = computeRowUpdates(row, validated.updates, jsonbSchema);
    assert.deepEqual(computed.updatedRow.size, { M: 13, XXL: 15 });
    assert.deepEqual(computed.before.size, { M: 3, XXL: 5 });
    assert.deepEqual(computed.after.size, { M: 13, XXL: 15 });

    const { updateSql, updateParams } = buildParameterizedUpdateStatement({
      schema: jsonbSchema,
      businessId,
      targetIds: [row.id],
      validatedUpdates: validated.updates,
      diffPreview: [{ ...computed, before: computed.before, after: computed.after }],
    });
    assert.match(updateSql, /THEN \$\d+::jsonb/);
    assert.deepEqual(updateParams.at(-1), { M: 13, XXL: 15 });
  });

  it('41. Executes natural-language row insertion (single and bulk create) with nested map keys and dynamic schemas', async () => {
    resetAllTables();

    setSheetGeminiGenerator(async (promptText) => {
      const userMessageMatch = promptText.match(
        /<user_message>\s*([\s\S]*?)\s*<\/user_message>/i
      );
      const userMsg = userMessageMatch ? userMessageMatch[1].trim().toLowerCase() : '';

      if (userMsg.includes('insert a new product linen summer shirt')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'create',
          updates: [
            { field: 'name', action: 'set', value: 'Linen Summer Shirt', unit: 'absolute' },
            { field: 'category', action: 'set', value: 'summer shirt', unit: 'absolute' },
            { field: 'price', action: 'set', value: 1650, unit: 'absolute' },
            { field: 'discount', action: 'set', value: 5, unit: 'absolute' },
            { field: 'color', action: 'set', value: 'Beige', unit: 'absolute' },
            { field: 'size.M', action: 'set', value: 10, unit: 'absolute' },
            { field: 'size.L', action: 'set', value: 8, unit: 'absolute' },
          ],
        };
      }

      if (userMsg.includes('add two laptops to electronics')) {
        return {
          status: 'ok',
          entity: 'electronics_inventory',
          operation: 'insert_many',
          rows: [
            {
              Product_Name: 'ThinkPad X1 Carbon',
              Brand_Name: 'Lenovo',
              Model: 'Gen 11',
              Current_Price: 1600,
              Stock_Qty: 12,
              Warehouse: 'Dhaka',
              Reorder_Level: 5,
              Warranty_Months: 24,
            },
            {
              Product_Name: 'Spectre x360',
              Brand_Name: 'HP',
              Model: '14-ef20',
              Current_Price: 1450,
              Stock_Qty: 7,
              Warehouse: 'Chittagong',
              Reorder_Level: 5,
              Warranty_Months: 12,
            },
          ],
        };
      }

      return { status: 'clarification_needed', message: 'Unhandled test prompt' };
    });

    // 1. Single-row NL create with dotted nested size.M and size.L via unified /query endpoint
    const previewRes = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message:
            'Insert a new product Linen Summer Shirt in category summer shirt with price 1650, discount 5%, color Beige, size M 10 and L 8.',
        }),
      }
    );
    assert.equal(previewRes.status, 200);
    const previewData = await previewRes.json();
    assert.equal(previewData.status, 'preview');
    assert.equal(previewData.operation, 'create');
    assert.equal(previewData.affected_count, 1);
    assert.equal(previewData.diff.length, 1);
    assert.equal(previewData.diff[0].after.name, 'Linen Summer Shirt');
    assert.deepEqual(JSON.parse(previewData.diff[0].after.size), { M: 10, L: 8 });

    // Confirm Stage 2
    const confirmRes = await fetch(
      `${baseUrl}/api/sheets/mutate?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          confirm: true,
          mutation: previewData.approved_mutation,
          expected_preview_hash: previewData.preview_hash,
        }),
      }
    );
    assert.equal(confirmRes.status, 200);
    const confirmData = await confirmRes.json();
    assert.equal(confirmData.status, 'success');
    assert.equal(confirmData.operation, 'create');
    assert.equal(confirmData.affected_count, 1);
    assert.equal(confirmData.created_row.name, 'Linen Summer Shirt');

    // 2. Multi-row NL create on dynamic electronics_inventory schema
    const multiPreviewRes = await fetch(
      `${baseUrl}/api/sheets/mutate?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'electronics_inventory',
          confirm: false,
          message: 'Add two laptops to electronics: Lenovo ThinkPad X1 Carbon and HP Spectre x360.',
        }),
      }
    );
    assert.equal(multiPreviewRes.status, 200);
    const multiPreview = await multiPreviewRes.json();
    assert.equal(multiPreview.status, 'preview');
    assert.equal(multiPreview.operation, 'create');
    assert.equal(multiPreview.affected_count, 2);
    assert.equal(multiPreview.diff.length, 2);

    const multiConfirmRes = await fetch(
      `${baseUrl}/api/sheets/mutate?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'electronics_inventory',
          confirm: true,
          mutation: multiPreview.approved_mutation,
          expected_preview_hash: multiPreview.preview_hash,
        }),
      }
    );
    assert.equal(multiConfirmRes.status, 200);
    const multiConfirm = await multiConfirmRes.json();
    assert.equal(multiConfirm.status, 'success');
    assert.equal(multiConfirm.affected_count, 2);
    assert.equal(multiConfirm.created_rows.length, 2);
  });

  it('42. Executes natural-language row deletion (single and conditional bulk delete) with preview diff and confirmation', async () => {
    resetAllTables();

    setSheetGeminiGenerator(async (promptText) => {
      const userMessageMatch = promptText.match(
        /<user_message>\s*([\s\S]*?)\s*<\/user_message>/i
      );
      const userMsg = userMessageMatch ? userMessageMatch[1].trim().toLowerCase() : '';

      if (userMsg.includes('delete stripe shirt and summer breeze shirt')) {
        return {
          status: 'ok',
          entity: 'products',
          operation: 'delete',
          target_filters: [
            {
              field: 'name',
              operator: 'in',
              value: ['Stripe Shirt', 'Summer Breeze Shirt'],
            },
          ],
        };
      }

      return { status: 'clarification_needed', message: 'Unhandled test prompt' };
    });

    // Stage 1: Preview deletion via unified /query endpoint
    const delPreviewRes = await fetch(
      `${baseUrl}/api/sheets/query?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          message: 'Delete Stripe Shirt and Summer Breeze Shirt from products.',
        }),
      }
    );
    assert.equal(delPreviewRes.status, 200);
    const delPreview = await delPreviewRes.json();
    assert.equal(delPreview.status, 'preview');
    assert.equal(delPreview.operation, 'delete');
    assert.equal(delPreview.affected_count, 2);
    assert.equal(delPreview.diff.length, 2);
    assert.equal(delPreview.diff[0].after, null);

    // Stage 2: Confirm deletion
    const delConfirmRes = await fetch(
      `${baseUrl}/api/sheets/mutate?businessId=${businessId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'products',
          confirm: true,
          mutation: delPreview.approved_mutation,
          expected_preview_hash: delPreview.preview_hash,
        }),
      }
    );
    assert.equal(delConfirmRes.status, 200);
    const delConfirm = await delConfirmRes.json();
    assert.equal(delConfirm.status, 'success');
    assert.equal(delConfirm.operation, 'delete');
    assert.equal(delConfirm.affected_count, 2);

    const remainingProducts = universalPool.getTableRows('products');
    assert.equal(remainingProducts.length, 1);
    assert.equal(remainingProducts[0].name, 'Nightfall Oxford Shirt');
  });

  it('43. Retrieves customer response context ONLY from the relevant business CSV sheet (products.csv vs services.csv)', async () => {
    resetAllTables();

    // Register and seed a second business sheet: services.csv (`services`)
    const servicesSchema = {
      entity: 'services',
      tableName: 'services',
      displayName: 'Services',
      columns: {
        id: { exactName: 'id', type: 'uuid', modifiable: false, queryable: true },
        business_id: { exactName: 'business_id', type: 'uuid', modifiable: false, queryable: false },
        service_name: { exactName: 'Service_Name', type: 'string', modifiable: true, queryable: true },
        category: { exactName: 'Category', type: 'string', modifiable: true, queryable: true },
        duration: { exactName: 'Duration', type: 'string', modifiable: true, queryable: true },
        hourly_rate: { exactName: 'Hourly_Rate', type: 'number', modifiable: true, queryable: true },
        description: { exactName: 'Description', type: 'string', modifiable: true, queryable: true },
      },
      representativeValues: {
        Service_Name: ['Express Suit Tailoring', 'Personal Wardrobe Styling Session'],
        Category: ['alteration service', 'consultation service'],
      },
    };
    registerTableSchema(servicesSchema);

    universalPool.setTableRows('services', [
      {
        id: '77777777-7777-4777-8777-777777777771',
        business_id: businessId,
        Service_Name: 'Express Suit Tailoring',
        Category: 'alteration service',
        Duration: '45 minutes',
        Hourly_Rate: 800,
        Description: 'Bespoke hemming and sleeve alteration service by master tailor.',
      },
      {
        id: '77777777-7777-4777-8777-777777777772',
        business_id: businessId,
        Service_Name: 'Personal Wardrobe Styling Session',
        Category: 'consultation service',
        Duration: '60 minutes',
        Hourly_Rate: 1500,
        Description: 'One-on-one styling consultation and outfit planning session.',
      },
    ]);

    // 1. Customer asks about a PRODUCT -> must ONLY query `products`, NEVER `services`
    universalPool.clearQueryLog();
    const productContext = await retrieveRelevantContextForBusiness(
      businessId,
      'Do you have the Stripe Shirt available in size XL and what is its price?'
    );
    const productQueries = universalPool.getQueryLog();
    const queriedServicesForProductMsg = productQueries.some(({ sql }) =>
      /\bFROM\s+"?services"?\b/i.test(sql)
    );
    const queriedProductsForProductMsg = productQueries.some(({ sql }) =>
      /\bFROM\s+"?products"?\b/i.test(sql)
    );
    assert.equal(
      queriedProductsForProductMsg,
      true,
      'Product inquiry must query products table'
    );
    assert.equal(
      queriedServicesForProductMsg,
      false,
      'Product inquiry must NOT query services table'
    );
    assert.ok(productContext.length > 0);
    assert.ok(productContext.every((entry) => entry.source_file === 'products.csv'));
    assert.ok(productContext.some((entry) => entry.title === 'Stripe Shirt'));

    // 2. Customer asks about a SERVICE -> must ONLY query `services`, NEVER `products`
    universalPool.clearQueryLog();
    const serviceContext = await retrieveRelevantContextForBusiness(
      businessId,
      'How much is the Express Suit Tailoring alteration service and what is the session duration?'
    );
    const serviceQueries = universalPool.getQueryLog();
    const queriedServicesForServiceMsg = serviceQueries.some(({ sql }) =>
      /\bFROM\s+"?services"?\b/i.test(sql)
    );
    const queriedProductsForServiceMsg = serviceQueries.some(({ sql }) =>
      /\bFROM\s+"?products"?\b/i.test(sql)
    );
    assert.equal(
      queriedServicesForServiceMsg,
      true,
      'Service inquiry must query services table'
    );
    assert.equal(
      queriedProductsForServiceMsg,
      false,
      'Service inquiry must NOT query products table'
    );
    assert.ok(serviceContext.length > 0);
    assert.ok(serviceContext.every((entry) => entry.source_file === 'services.csv'));
    assert.ok(
      serviceContext.some((entry) => entry.title === 'Express Suit Tailoring')
    );
  });

  it('44. Routes ordinary table queries and mutations back to their existing Gemini-backed sheet workflows', async () => {
    const routingPrompts = [];
    setWorkspaceGeminiGenerator(async (promptText) => {
      routingPrompts.push(promptText);
      if (promptText.toLowerCase().includes('decrease discount')) {
        return { intent: 'sheet_mutation', entity: 'products' };
      }
      return { intent: 'sheet_query', entity: 'products' };
    });

    try {
      const queryResponse = await fetch(
        `${baseUrl}/api/workspace/execute?business_id=${businessId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: businessId,
            entity: 'products',
            prompt: 'Show luxury shirts.',
          }),
        }
      );
      const queryResult = await queryResponse.json();
      assert.equal(queryResult.status, 'SHEET_QUERY');
      assert.equal(queryResult.entity, 'products');

      const mutationResponse = await fetch(
        `${baseUrl}/api/workspace/execute?business_id=${businessId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: businessId,
            entity: 'products',
            prompt: 'Decrease discount by 10% for all luxury shirts.',
            history: [{ role: 'user', content: 'I am working with the apparel sheet.' }],
          }),
        }
      );
      const mutationResult = await mutationResponse.json();
      assert.equal(mutationResult.status, 'SHEET_MUTATION');
      assert.equal(mutationResult.entity, 'products');
      assert.equal(routingPrompts.length, 2);
      assert.match(routingPrompts[1], /apparel sheet/i);
    } finally {
      setWorkspaceGeminiGenerator(null);
    }
  });

  it('45. GET /api/sheets/tables returns only tables belonging to the logged-in business_id and empty array when none belong', async () => {
    const demoOpsBizId = '11111111-2222-3333-4444-555555555555';
    const emptyBizId = '99999999-9999-4999-8999-999999999999';

    await universalPool.query('INSERT INTO businesses (id, name) VALUES ($1, $2)', [
      demoOpsBizId,
      'Echo Demo Operations Workspace',
    ]);
    await universalPool.query('INSERT INTO businesses (id, name) VALUES ($1, $2)', [
      emptyBizId,
      'Empty Business Workspace',
    ]);

    registerTableSchema({
      entity: 'orders',
      tableName: 'orders',
      displayName: 'Orders',
      columns: {
        id: { exactName: 'id', type: 'uuid' },
        business_id: { exactName: 'business_id', type: 'uuid' },
        order_id: { exactName: 'order_id', type: 'string' },
        customer_name: { exactName: 'customer_name', type: 'string' },
        status: { exactName: 'status', type: 'string' },
      },
    });
    universalPool.setTableRows('orders', [
      {
        id: '44444444-4444-4444-8444-444444444441',
        business_id: demoOpsBizId,
        order_id: 'ORD-1001',
        customer_name: 'Alice',
        status: 'Delayed',
      },
    ]);

    // 1. Echo Demo Operations Workspace (11111111-2222-3333-4444-555555555555) ONLY sees orders.csv, NOT products.csv
    const demoRes = await fetch(`${baseUrl}/api/sheets/tables?businessId=${demoOpsBizId}`);
    assert.equal(demoRes.status, 200);
    const demoBody = await demoRes.json();
    assert.equal(demoBody.business_id, demoOpsBizId);
    assert.deepEqual(
      demoBody.tables.map((t) => t.entity),
      ['orders']
    );
    assert.equal(demoBody.tables[0].fileName, 'orders.csv');

    // 2. Empty Business Workspace (99999999-9999-4999-8999-999999999999) sees 0 tables
    const emptyRes = await fetch(`${baseUrl}/api/sheets/tables?businessId=${emptyBizId}`);
    assert.equal(emptyRes.status, 200);
    const emptyBody = await emptyRes.json();
    assert.equal(emptyBody.business_id, emptyBizId);
    assert.deepEqual(emptyBody.tables, []);
    assert.equal(emptyBody.count, 0);
  });

  it('46. Requires explicit whole-table scope before previewing an unfiltered match_all mutation', async () => {
    setSheetGeminiGenerator(async () => ({
      status: 'ok',
      entity: 'products',
      operation: 'update_many',
      match_all: true,
      target_filters: [],
      updates: [{ field: 'discount', action: 'add', value: 5, unit: 'absolute' }],
    }));

    try {
      const requestPreview = async (message) => {
        const response = await fetch(
          `${baseUrl}/api/sheets/products/mutate?businessId=${businessId}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              entity: 'products',
              message,
              confirm: false,
            }),
          }
        );
        return response.json();
      };

      const missingScope = await requestPreview('Increase the discount by 5%.');
      assert.equal(missingScope.status, 'clarification_needed');
      assert.match(missingScope.message, /does not clearly ask for a whole-table operation/i);
      assert.equal(missingScope.affected_count, 0);
      assert.equal(missingScope.preview_hash, undefined);

      const beforeUnsafeExecution = universalPool
        .getTableRows('products')
        .map((row) => row.discount);
      const unsafeExecutionResponse = await fetch(
        `${baseUrl}/api/sheets/products/mutate?businessId=${businessId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity: 'products',
            message: 'Increase the discount by 5%.',
            mutation: {
              operation: 'update_many',
              match_all: true,
              target_filters: [],
              updates: [
                { field: 'discount', action: 'add', value: 5, unit: 'absolute' },
              ],
            },
            confirm: true,
          }),
        }
      );
      const unsafeExecution = await unsafeExecutionResponse.json();
      assert.equal(unsafeExecution.status, 'clarification_needed');
      assert.deepEqual(
        universalPool.getTableRows('products').map((row) => row.discount),
        beforeUnsafeExecution,
        'An unscoped match_all plan must not change any rows during confirmation.'
      );

      const qualifiedScope = await requestPreview(
        'Increase stock for all luxury shirts for all sizes by 10.'
      );
      assert.equal(qualifiedScope.status, 'clarification_needed');
      assert.equal(qualifiedScope.affected_count, 0);

      const explicitScope = await requestPreview(
        'Increase the discount by 5% for all rows in the table.'
      );
      assert.equal(explicitScope.status, 'preview');
      assert.ok(explicitScope.affected_count > 0);
      assert.ok(explicitScope.preview_hash);
    } finally {
      setSheetGeminiGenerator(null);
    }
  });
});
