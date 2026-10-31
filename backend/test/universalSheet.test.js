const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { setPool } = require('../db');
const { setSheetGeminiGenerator } = require('../src/services/geminiService');
const {
  discoverTableSchema,
  getSchema,
  registerTableSchema,
} = require('../src/services/sheetSchemaService');
const { buildSheetQueryPrompt } = require('../src/services/sheetQueryPromptBuilder');

/**
 * Creates an in-memory PostgreSQL simulator supporting products, electronics_inventory,
 * grocery_inventory, dynamic information_schema inspection, and parameterized queries.
 */
function createUniversalSheetPool() {
  const businesses = new Map();
  const tables = new Map();

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
    };
  }

  function restoreState(snap) {
    for (const [k, rows] of snap.tables.entries()) {
      tables.set(k, rows);
    }
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
      /\(size::jsonb\s*->>\s*'([A-Za-z0-9]+)'\)[\s\S]+?,\s*0\)\s*(=|<>|>=|<=|>|<)\s*\$(\d+)/i
    );
    if (sizeKeyMatch) {
      const sizeKey = sizeKeyMatch[1];
      const op = sizeKeyMatch[2];
      const targetVal = Number(params[Number(sizeKeyMatch[3]) - 1]);
      let actualVal = 0;
      try {
        const parsed = JSON.parse(row.size || '{}');
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
    const ilikeMatch = trimmed.match(/^([a-z0-9_]+)\s+ILIKE\s+\$(\d+)$/i);
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

    // 3. Nested size CASE id
    if (/^size\s*=\s*CASE\s+id/i.test(trimmed)) {
      const whenMatches = [...trimmed.matchAll(/WHEN\s+\$(\d+)::uuid\s+THEN\s+\$(\d+)/gi)];
      for (const m of whenMatches) {
        const idParam = params[Number(m[1]) - 1];
        const valParam = params[Number(m[2]) - 1];
        if (row.id === idParam) {
          row.size = valParam;
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
      const requestedTable = String(params[0] || '').toLowerCase();
      const exists = tables.has(requestedTable);
      return {
        rows: exists ? [{ exists: true }] : [],
        rowCount: exists ? 1 : 0,
      };
    }

    // 2. Business lookup
    if (normalized.startsWith('SELECT ID, NAME, CREATED_AT FROM BUSINESSES WHERE ID = $1')) {
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
        is_nullable: 'YES',
      }));
      return { rows, rowCount: rows.length };
    }

    // 4. Catalog names lookup: SELECT ... FROM <table> WHERE business_id = $1 ORDER BY ...
    const catMatch = rawSql.match(/SELECT\s+([^FROM]+)\s+FROM\s+["']?([a-z0-9_]+)["']?\s+WHERE\s+business_id\s*=\s*\$1\s+ORDER\s+BY/i);
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
    const delAllMatch = rawSql.match(/^DELETE\s+FROM\s+["']?([a-z0-9_]+)["']?\s+WHERE\s+business_id\s*=\s*\$1;?$/i);
    if (delAllMatch) {
      const tableName = delAllMatch[1].toLowerCase();
      const before = tables.get(tableName) || [];
      const after = before.filter((r) => r.business_id !== params[0]);
      tables.set(tableName, after);
      return { rows: [], rowCount: before.length - after.length };
    }

    // 6. INSERT INTO <table>
    const insertMatch = rawSql.match(/INSERT\s+INTO\s+["']?([a-z0-9_]+)["']?\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const tableName = insertMatch[1].toLowerCase();
      const cols = insertMatch[2].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
      const row = { id: crypto.randomUUID(), created_at: nextIsoTimestamp(), updated_at: nextIsoTimestamp() };
      cols.forEach((col, idx) => {
        if (params[idx] !== undefined) {
          row[col] = params[idx];
          row[col.toLowerCase()] = params[idx];
        }
      });
      if (!tables.has(tableName)) tables.set(tableName, []);
      tables.get(tableName).push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // 7. SELECT * FROM <table>
    const selectMatch = rawSql.match(/SELECT\s+\*\s+FROM\s+["']?([a-z0-9_]+)["']?\s+WHERE\s+business_id\s*=\s*\$1/i);
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
      const wherePartMatch = rawSql.match(/WHERE\s+business_id\s*=\s*\$1(?:\s+AND\s+([\s\S]+?))?(?:\s+ORDER\s+BY|\s+LIMIT|$)/i);
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
    const deleteMatch = rawSql.match(/DELETE\s+FROM\s+["']?([a-z0-9_]+)["']?\s+WHERE\s+business_id\s*=\s*\$1\s+AND\s+id\s*=\s*ANY/i);
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
    assert.ok(elecPrompt.includes('Dhaka, Chittagong'));
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
    assert.ok(grocPrompt.includes('Acme, NorthStar'));
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
});
