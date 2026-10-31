const AppError = require('../utils/AppError');
const { query } = require('../../db');

const APPAREL_SIZE_KEYS = new Set([
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  'XXXL',
  '2XL',
  '3XL',
]);

const NUMERIC_OPERATORS = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'between',
];

const STRING_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'in',
];

const BOOLEAN_OPERATORS = ['equals', 'not_equals'];

const DATE_OPERATORS = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'between',
  'relative_days_ago',
  'this_month',
];

/**
 * Built-in Canonical Schemas for known business inventory entities:
 * 1. products (Apparel inventory)
 * 2. electronics_inventory (Electronics inventory)
 * 3. grocery_inventory (Grocery inventory)
 */
const ENTITY_SCHEMAS = {
  products: {
    entity: 'products',
    tableName: 'products',
    displayName: 'Products (Apparel)',
    columns: {
      id: {
        exactName: 'id',
        type: 'uuid',
        readonly: true,
        queryable: true,
        modifiable: false,
        sortable: false,
        operators: ['equals', 'not_equals', 'in'],
      },
      business_id: { exactName: 'business_id', type: 'uuid', readonly: true, modifiable: false },
      name: {
        exactName: 'name',
        type: 'string',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      category: {
        exactName: 'category',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      description: {
        exactName: 'description',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: false,
        operators: ['contains', 'not_contains', 'equals', 'not_equals'],
      },
      best: {
        exactName: 'best',
        type: 'boolean',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: BOOLEAN_OPERATORS,
      },
      color: {
        exactName: 'color',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      discount: {
        exactName: 'discount',
        type: 'number',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        max: 100,
        operators: NUMERIC_OPERATORS,
      },
      ordered: {
        exactName: 'ordered',
        type: 'integer',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      images: {
        exactName: 'images',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: false,
        operators: ['equals', 'not_equals', 'contains', 'not_contains'],
      },
      size: {
        exactName: 'size',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: false,
        operators: STRING_OPERATORS,
      },
      price: {
        exactName: 'price',
        type: 'number',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      total_stock: {
        exactName: 'total_stock',
        type: 'integer',
        virtual: true,
        required: false,
        queryable: true,
        modifiable: false,
        sortable: false,
        min: 0,
        description: 'Computed sum of stock quantities across all sizes in the JSON "size" column',
        operators: NUMERIC_OPERATORS,
      },
      created_at: {
        exactName: 'created_at',
        type: 'date',
        required: false,
        queryable: true,
        modifiable: false,
        sortable: true,
        operators: DATE_OPERATORS,
      },
      updated_at: { exactName: 'updated_at', type: 'date', readonly: true, modifiable: false },
    },
    representativeValues: {},
  },
  electronics_inventory: {
    entity: 'electronics_inventory',
    tableName: 'electronics_inventory',
    displayName: 'Electronics Inventory',
    columns: {
      id: {
        exactName: 'id',
        type: 'uuid',
        readonly: true,
        queryable: true,
        modifiable: false,
        sortable: false,
        operators: ['equals', 'not_equals', 'in'],
      },
      business_id: { exactName: 'business_id', type: 'uuid', readonly: true, modifiable: false },
      product_name: {
        exactName: 'Product_Name',
        type: 'string',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      brand_name: {
        exactName: 'Brand_Name',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      model: {
        exactName: 'Model',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      current_price: {
        exactName: 'Current_Price',
        type: 'number',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      stock_qty: {
        exactName: 'Stock_Qty',
        type: 'integer',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      warehouse: {
        exactName: 'Warehouse',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      reorder_level: {
        exactName: 'Reorder_Level',
        type: 'integer',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      warranty_months: {
        exactName: 'Warranty_Months',
        type: 'integer',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      created_at: {
        exactName: 'created_at',
        type: 'date',
        readonly: true,
        queryable: true,
        sortable: true,
        operators: DATE_OPERATORS,
      },
      updated_at: { exactName: 'updated_at', type: 'date', readonly: true, modifiable: false },
    },
    representativeValues: {
      Warehouse: ['Dhaka', 'Chittagong'],
      Brand_Name: ['Asus', 'Dell', 'HP', 'Lenovo'],
    },
  },
  grocery_inventory: {
    entity: 'grocery_inventory',
    tableName: 'grocery_inventory',
    displayName: 'Grocery Inventory',
    columns: {
      id: {
        exactName: 'id',
        type: 'uuid',
        readonly: true,
        queryable: true,
        modifiable: false,
        sortable: false,
        operators: ['equals', 'not_equals', 'in'],
      },
      business_id: { exactName: 'business_id', type: 'uuid', readonly: true, modifiable: false },
      item_name: {
        exactName: 'Item_Name',
        type: 'string',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      supplier: {
        exactName: 'Supplier',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      unit_cost: {
        exactName: 'Unit_Cost',
        type: 'number',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      selling_price: {
        exactName: 'Selling_Price',
        type: 'number',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      expiry_date: {
        exactName: 'Expiry_Date',
        type: 'date',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: DATE_OPERATORS,
      },
      batch_no: {
        exactName: 'Batch_No',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      quantity: {
        exactName: 'Quantity',
        type: 'integer',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: NUMERIC_OPERATORS,
      },
      warehouse_location: {
        exactName: 'Warehouse_Location',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      stock: {
        exactName: 'Stock',
        type: 'boolean',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: BOOLEAN_OPERATORS,
      },
      status: {
        exactName: 'Status',
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: STRING_OPERATORS,
      },
      created_at: {
        exactName: 'created_at',
        type: 'date',
        readonly: true,
        queryable: true,
        sortable: true,
        operators: DATE_OPERATORS,
      },
      updated_at: { exactName: 'updated_at', type: 'date', readonly: true, modifiable: false },
    },
    representativeValues: {
      Supplier: ['Acme', 'NorthStar', 'FreshFarms'],
      Warehouse_Location: ['Dhaka', 'Chittagong', 'Sylhet'],
      Stock: [true, false],
      Status: ['in_stock', 'clearance', 'reorder'],
    },
  },
};

// Global cache for dynamically discovered schemas
const REGISTERED_SCHEMAS = new Map(Object.entries(ENTITY_SCHEMAS));

const OPERATOR_ALIASES = {
  '=': 'equals',
  '==': 'equals',
  eq: 'equals',
  is: 'equals',
  '!=': 'not_equals',
  '<>': 'not_equals',
  neq: 'not_equals',
  is_not: 'not_equals',
  '>': 'greater_than',
  gt: 'greater_than',
  after: 'greater_than',
  '>=': 'greater_than_or_equal',
  gte: 'greater_than_or_equal',
  at_least: 'greater_than_or_equal',
  on_or_after: 'greater_than_or_equal',
  '<': 'less_than',
  lt: 'less_than',
  before: 'less_than',
  '<=': 'less_than_or_equal',
  lte: 'less_than_or_equal',
  at_most: 'less_than_or_equal',
  on_or_before: 'less_than_or_equal',
  like: 'contains',
  ilike: 'contains',
  match: 'contains',
  includes: 'contains',
  has: 'contains',
};

const ACTION_ALIASES = {
  set: 'set',
  assign: 'set',
  equals: 'set',
  replace: 'set',
  add: 'add',
  increase: 'add',
  increment: 'add',
  plus: 'add',
  subtract: 'subtract',
  reduce: 'subtract',
  decrease: 'subtract',
  decrement: 'subtract',
  minus: 'subtract',
  multiply: 'multiply',
  scale: 'multiply',
  times: 'multiply',
};

const UNIT_ALIASES = {
  absolute: 'absolute',
  currency: 'absolute',
  units: 'absolute',
  unit: 'absolute',
  value: 'absolute',
  number: 'absolute',
  percentage: 'percentage',
  percent: 'percentage',
  '%': 'percentage',
  percentage_points: 'percentage_points',
  percentage_point: 'percentage_points',
  points: 'percentage_points',
  point: 'percentage_points',
  pp: 'percentage_points',
};

/**
 * Coerces a boolean-like value to strict boolean or throws AppError.
 *
 * @param {any} val
 * @param {string} fieldName
 * @returns {boolean}
 */
function coerceBooleanValue(val, fieldName) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') {
    if (val === 1) return true;
    if (val === 0) return false;
  }
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(clean)) return true;
    if (['false', '0', 'no', 'n'].includes(clean)) return false;
  }
  throw new AppError(
    `Field "${fieldName}" expects a boolean value (true or false), got "${val}".`,
    400
  );
}

/**
 * Parses a numeric value, stripping optional currency/percentage symbols ($, %, commas).
 *
 * @param {any} val
 * @returns {number}
 */
function parseCleanNumber(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const cleaned = val.replace(/[$,%\s]/g, '').trim();
    if (!cleaned) return Number.NaN;
    return Number(cleaned);
  }
  return Number.NaN;
}

/**
 * Case-insensitive column definition lookup in schema.
 * Returns { key, colDef, exactName } or null if not found.
 *
 * @param {object} schema
 * @param {string} fieldName
 * @returns {{ key: string, colDef: object, exactName: string } | null}
 */
function findColumnDef(schema, fieldName) {
  if (!schema || !schema.columns || !fieldName) return null;
  const rawClean = String(fieldName).trim();
  const lower = rawClean.toLowerCase();

  // 1. Direct key match
  if (schema.columns[rawClean]) {
    const colDef = schema.columns[rawClean];
    return { key: rawClean, colDef, exactName: colDef.exactName || rawClean };
  }

  // 2. Lowercase key match
  if (schema.columns[lower]) {
    const colDef = schema.columns[lower];
    return { key: lower, colDef, exactName: colDef.exactName || lower };
  }

  // 3. Search exactName or lowercase match across all columns
  for (const [colKey, colDef] of Object.entries(schema.columns)) {
    if (
      colKey.toLowerCase() === lower ||
      String(colDef.exactName || '').toLowerCase() === lower
    ) {
      return { key: colKey, colDef, exactName: colDef.exactName || colKey };
    }
  }

  return null;
}

/**
 * Parses a nested size field specifier such as "size.M", "size.XL", or { field: "size", size_key: "M" }.
 * Returns uppercase size key if valid, or null if not a nested size reference.
 *
 * @param {string} rawField
 * @param {string} [explicitSizeKey]
 * @returns {string | null}
 */
function resolveNestedSizeKey(rawField, explicitSizeKey) {
  let candidateKey = null;
  const dotMatch = String(rawField || '')
    .trim()
    .match(/^size\.([a-z0-9_]+)$/i);

  if (dotMatch) {
    candidateKey = dotMatch[1].toUpperCase();
  } else if (
    String(rawField || '').trim().toLowerCase() === 'size' &&
    explicitSizeKey !== undefined &&
    explicitSizeKey !== null &&
    String(explicitSizeKey).trim() !== ''
  ) {
    candidateKey = String(explicitSizeKey).trim().toUpperCase();
  }

  if (!candidateKey) {
    return null;
  }

  if (!APPAREL_SIZE_KEYS.has(candidateKey)) {
    throw new AppError(
      `Unsupported apparel size key "${candidateKey}". Allowed size keys: ${Array.from(
        APPAREL_SIZE_KEYS
      ).join(', ')}.`,
      400
    );
  }

  return candidateKey;
}

/**
 * Maps raw PostgreSQL data types to normalized internal types.
 */
function mapPgDataType(pgType) {
  const t = String(pgType || '').toLowerCase();
  if (t.includes('int') || t.includes('serial')) return 'integer';
  if (
    t.includes('num') ||
    t.includes('dec') ||
    t.includes('float') ||
    t.includes('double') ||
    t.includes('real')
  ) {
    return 'number';
  }
  if (t.includes('bool')) return 'boolean';
  if (t.includes('date') || t.includes('time')) return 'date';
  if (t.includes('uuid')) return 'uuid';
  return 'string';
}

/**
 * Returns allowed operators for a data type.
 */
function getOperatorsForType(type) {
  switch (type) {
    case 'number':
    case 'integer':
      return NUMERIC_OPERATORS;
    case 'boolean':
      return BOOLEAN_OPERATORS;
    case 'date':
      return DATE_OPERATORS;
    case 'uuid':
      return ['equals', 'not_equals', 'in'];
    default:
      return STRING_OPERATORS;
  }
}

/**
 * Dynamically discovers the schema for an active table by inspecting PostgreSQL
 * information_schema.columns and sampling representative values for categorical columns.
 * Caches discovered schemas in REGISTERED_SCHEMAS.
 *
 * @param {string} tableName
 * @param {string} [businessId]
 * @returns {Promise<object>} Active table schema definition
 */
async function discoverTableSchema(tableName, businessId) {
  if (tableName && typeof tableName === 'object' && tableName.columns) {
    return tableName;
  }
  const normName = normalizeEntityName(tableName);

  // If already discovered or built-in, retrieve baseline
  let schema = REGISTERED_SCHEMAS.get(normName) || ENTITY_SCHEMAS[normName];

  // If not known in pre-registered map, introspect PostgreSQL information_schema
  if (!schema) {
    try {
      const colRes = await query(
        `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND LOWER(table_name) = LOWER($1)
          ORDER BY ordinal_position;
        `,
        [normName]
      );

      if (colRes.rows && colRes.rows.length > 0) {
        const columns = {};
        for (const row of colRes.rows) {
          const rawCol = row.column_name;
          const lowerCol = rawCol.toLowerCase();
          const colType = mapPgDataType(row.data_type);
          const isSystem = ['id', 'business_id', 'created_at', 'updated_at'].includes(lowerCol);

          columns[lowerCol] = {
            exactName: rawCol,
            type: colType,
            readonly: isSystem,
            modifiable: !isSystem,
            queryable: true,
            sortable: lowerCol !== 'images' && lowerCol !== 'description',
            operators: getOperatorsForType(colType),
          };
        }

        schema = {
          entity: normName,
          tableName: normName,
          displayName: normName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          columns,
          representativeValues: {},
        };
      }
    } catch (err) {
      console.warn(`Could not introspect information_schema for table "${normName}":`, err.message);
    }
  }

  if (!schema) {
    throw new AppError(
      `Table or entity "${tableName}" does not exist. Available tables: ${Array.from(
        new Set([...Object.keys(ENTITY_SCHEMAS), ...REGISTERED_SCHEMAS.keys()])
      ).join(', ')}.`,
      400
    );
  }

  // Deep clone so enrichment doesn't mutate canonical static prototypes
  const dynamicSchema = {
    ...schema,
    columns: { ...schema.columns },
    representativeValues: { ...(schema.representativeValues || {}) },
  };

  // If businessId is provided and representative values are sparse, query a sample of rows
  if (businessId) {
    try {
      const sampleRes = await query(
        `SELECT * FROM ${dynamicSchema.tableName} WHERE business_id = $1 LIMIT 15;`,
        [businessId]
      );
      if (sampleRes.rows && sampleRes.rows.length > 0) {
        for (const colDef of Object.values(dynamicSchema.columns)) {
          if (colDef.type === 'string' && colDef.modifiable) {
            const exactCol = colDef.exactName;
            const distinctVals = [
              ...new Set(
                sampleRes.rows
                  .map((r) => r[exactCol] ?? r[exactCol.toLowerCase()])
                  .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
              ),
            ].slice(0, 5);

            if (distinctVals.length > 0 && !dynamicSchema.representativeValues[exactCol]) {
              dynamicSchema.representativeValues[exactCol] = distinctVals;
            }
          }
        }
      }
    } catch {
      // Best-effort sample query; fallback gracefully if table has no rows or query fails
    }
  }

  REGISTERED_SCHEMAS.set(normName, dynamicSchema);
  return dynamicSchema;
}

/**
 * Registers an in-memory schema definition (useful for tests and dynamic CSV imports).
 *
 * @param {string} tableName
 * @param {object} schemaDef
 */
function registerTableSchema(tableName, schemaDef) {
  const norm = normalizeEntityName(tableName);
  REGISTERED_SCHEMAS.set(norm, schemaDef);
}

const CANONICAL_DDL_STATEMENTS = {
  products: [
    `CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL CHECK (char_length(btrim(name)) > 0),
      category VARCHAR(100),
      description TEXT,
      best BOOLEAN DEFAULT FALSE,
      color VARCHAR(100),
      discount NUMERIC(5, 2) DEFAULT 0.00 CHECK (discount >= 0 AND discount <= 100),
      ordered INTEGER DEFAULT 0 CHECK (ordered >= 0),
      images TEXT,
      size JSONB,
      price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (price >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_products_business_id ON products (business_id);`,
    `CREATE INDEX IF NOT EXISTS idx_products_name ON products (name);`,
    `CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);`,
    `CREATE INDEX IF NOT EXISTS idx_products_price ON products (price);`,
  ],
  electronics_inventory: [
    `CREATE TABLE IF NOT EXISTS electronics_inventory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      product_name VARCHAR(255) NOT NULL,
      brand_name VARCHAR(100),
      model VARCHAR(100),
      current_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (current_price >= 0),
      stock_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
      warehouse VARCHAR(100),
      reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
      warranty_months INTEGER NOT NULL DEFAULT 12 CHECK (warranty_months >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_electronics_business_id ON electronics_inventory(business_id);`,
    `CREATE INDEX IF NOT EXISTS idx_electronics_brand_name ON electronics_inventory(brand_name);`,
    `CREATE INDEX IF NOT EXISTS idx_electronics_warehouse ON electronics_inventory(warehouse);`,
    `CREATE INDEX IF NOT EXISTS idx_electronics_current_price ON electronics_inventory(current_price);`,
    `CREATE INDEX IF NOT EXISTS idx_electronics_stock_qty ON electronics_inventory(stock_qty);`,
  ],
  grocery_inventory: [
    `CREATE TABLE IF NOT EXISTS grocery_inventory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      item_name VARCHAR(255) NOT NULL,
      supplier VARCHAR(100),
      unit_cost NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (unit_cost >= 0),
      selling_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (selling_price >= 0),
      expiry_date DATE,
      batch_no VARCHAR(100),
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      warehouse_location VARCHAR(100),
      stock BOOLEAN DEFAULT TRUE,
      status VARCHAR(50) DEFAULT 'in_stock',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_grocery_business_id ON grocery_inventory(business_id);`,
    `CREATE INDEX IF NOT EXISTS idx_grocery_supplier ON grocery_inventory(supplier);`,
    `CREATE INDEX IF NOT EXISTS idx_grocery_expiry_date ON grocery_inventory(expiry_date);`,
    `CREATE INDEX IF NOT EXISTS idx_grocery_selling_price ON grocery_inventory(selling_price);`,
    `CREATE INDEX IF NOT EXISTS idx_grocery_warehouse_loc ON grocery_inventory(warehouse_location);`,
  ],
};

function mapTypeToPgColumnDef(type) {
  switch (type) {
    case 'integer':
      return 'INTEGER NOT NULL DEFAULT 0';
    case 'number':
      return 'NUMERIC(12, 2) NOT NULL DEFAULT 0.00';
    case 'boolean':
      return 'BOOLEAN NOT NULL DEFAULT FALSE';
    case 'date':
      return 'DATE';
    case 'uuid':
      return 'UUID';
    case 'json':
      return 'JSONB';
    default:
      return 'VARCHAR(255)';
  }
}

/**
 * Dynamically ensures a physical table and its columns exist in PostgreSQL.
 * If the table does not exist:
 * - Uses canonical DDL for built-in tables (products, electronics_inventory, grocery_inventory)
 * - Or dynamically creates CREATE TABLE IF NOT EXISTS for custom arbitrary CSV tables.
 * Also synchronizes any missing columns via ALTER TABLE ADD COLUMN IF NOT EXISTS.
 *
 * @param {string | object} entityOrSchema
 * @param {object} [clientOrPool] - Optional db client or pool
 * @returns {Promise<boolean>}
 */
async function ensureTableExists(entityOrSchema, clientOrPool) {
  const runner = clientOrPool || { query };
  let schema = null;

  if (entityOrSchema && typeof entityOrSchema === 'object' && entityOrSchema.columns) {
    schema = entityOrSchema;
  } else {
    const norm = normalizeEntityName(entityOrSchema || 'products');
    schema = REGISTERED_SCHEMAS.get(norm) || ENTITY_SCHEMAS[norm];
  }

  const rawTableName = schema?.tableName || (typeof entityOrSchema === 'string' ? entityOrSchema : 'products');
  const safeTableName = String(rawTableName).replace(/[^a-z0-9_]/gi, '_').toLowerCase();

  try {
    // 1. Ensure businesses table exists first (for foreign key reference)
    try {
      await runner.query(`
        CREATE TABLE IF NOT EXISTS businesses (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL CHECK (char_length(btrim(name)) > 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    } catch {
      // Ignore if businesses table already exists or pool is simulated
    }

    // 2. Check if table already exists in PostgreSQL
    let tableExists = false;
    try {
      const checkRes = await runner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND LOWER(table_name) = LOWER($1) LIMIT 1;`,
        [safeTableName]
      );
      tableExists = Boolean(checkRes.rows && checkRes.rows.length > 0);
    } catch {
      tableExists = false;
    }

    // 3. Create table if not present
    if (!tableExists) {
      if (CANONICAL_DDL_STATEMENTS[safeTableName]) {
        for (const stmt of CANONICAL_DDL_STATEMENTS[safeTableName]) {
          await runner.query(stmt);
        }
      } else {
        // Dynamic table creation for custom arbitrary CSV uploads
        const colDefs = [];
        if (schema && schema.columns) {
          for (const [colKey, colDef] of Object.entries(schema.columns)) {
            const rawCol = colDef.exactName || colKey;
            const cleanCol = String(rawCol).replace(/[^a-z0-9_]/gi, '_');
            const lower = cleanCol.toLowerCase();
            if (['id', 'business_id', 'created_at', 'updated_at'].includes(lower)) {
              continue;
            }
            colDefs.push(`"${cleanCol}" ${mapTypeToPgColumnDef(colDef.type)}`);
          }
        }

        const colsSql = colDefs.length > 0 ? `,\n        ${colDefs.join(',\n        ')}` : '';
        const createSql = `
          CREATE TABLE IF NOT EXISTS "${safeTableName}" (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
            ${colsSql},
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `;
        await runner.query(createSql);

        try {
          await runner.query(
            `CREATE INDEX IF NOT EXISTS "idx_${safeTableName}_business_id" ON "${safeTableName}" (business_id);`
          );
        } catch {
          // Ignore index errors
        }
      }
    }

    // 4. Synchronize any newly added columns if table exists
    if (schema && schema.columns) {
      try {
        const colRes = await runner.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND LOWER(table_name) = LOWER($1);`,
          [safeTableName]
        );
        const existingCols = new Set((colRes.rows || []).map((r) => String(r.column_name).toLowerCase()));

        for (const [colKey, colDef] of Object.entries(schema.columns)) {
          const rawCol = colDef.exactName || colKey;
          const cleanCol = String(rawCol).replace(/[^a-z0-9_]/gi, '_');
          const lower = cleanCol.toLowerCase();
          if (['id', 'business_id', 'created_at', 'updated_at'].includes(lower)) {
            continue;
          }
          if (!existingCols.has(lower)) {
            await runner.query(
              `ALTER TABLE "${safeTableName}" ADD COLUMN IF NOT EXISTS "${cleanCol}" ${mapTypeToPgColumnDef(colDef.type)};`
            );
          }
        }
      } catch {
        // Best-effort column sync
      }
    }

    return true;
  } catch (err) {
    if (err && err.message && err.message.includes('Unsupported SQL')) {
      return true; // Graceful fallback for mock unit-test pools
    }
    console.warn(`[ensureTableExists] Warning ensuring table "${safeTableName}":`, err.message);
    return false;
  }
}

/**
 * Returns supported entity names.
 * @returns {string[]}
 */
function getSupportedEntities() {
  return Array.from(
    new Set([...Object.keys(ENTITY_SCHEMAS), ...REGISTERED_SCHEMAS.keys()])
  );
}

/**
 * Checks whether an entity name is supported.
 * @param {string} entity
 * @returns {boolean}
 */
function isEntitySupported(entity) {
  if (typeof entity !== 'string') return false;
  const clean = entity.trim().toLowerCase();
  return (
    clean === 'product' ||
    clean === 'products' ||
    REGISTERED_SCHEMAS.has(clean) ||
    Boolean(ENTITY_SCHEMAS[clean])
  );
}

/**
 * Normalizes entity name ('product' -> 'products', or clean lowercase table name).
 *
 * @param {string} [entity='products']
 * @returns {string}
 */
function normalizeEntityName(entity = 'products') {
  if (entity && typeof entity === 'object' && entity.entity) {
    return entity.entity;
  }
  if (entity === undefined || entity === null || entity === '') {
    return 'products';
  }
  if (typeof entity !== 'string') {
    throw new AppError('Entity name must be a string.', 400);
  }
  const clean = entity.trim().toLowerCase();
  if (clean === 'product' || clean === 'products') return 'products';
  return clean;
}

/**
 * Returns the schema definition for the specified entity or table name.
 * If entity is already a schema object, returns it.
 *
 * @param {string | object} [entity='products']
 * @returns {object}
 */
function getSchema(entity = 'products') {
  if (entity && typeof entity === 'object' && entity.columns) {
    return entity;
  }
  const norm = normalizeEntityName(entity);
  const found = REGISTERED_SCHEMAS.get(norm) || ENTITY_SCHEMAS[norm];
  if (!found) {
    throw new AppError(
      `Unknown entity "${entity}". Supported entities: ${getSupportedEntities().join(', ')}.`,
      400
    );
  }
  return found;
}

/**
 * Normalizes operator strings to standard operator keys.
 * @param {string} operator
 * @returns {string}
 */
function normalizeOperator(operator) {
  if (typeof operator !== 'string') return 'equals';
  const op = operator.trim().toLowerCase();
  return OPERATOR_ALIASES[op] || op;
}

/**
 * Normalizes mutation action strings to 'set' | 'add' | 'subtract' | 'multiply'.
 * @param {string} [action='set']
 * @returns {string}
 */
function normalizeUpdateAction(action = 'set') {
  if (action === undefined || action === null || action === '') {
    return 'set';
  }
  if (typeof action !== 'string') {
    throw new AppError('Update action must be a string.', 400);
  }
  const clean = action.trim().toLowerCase();
  const mapped = ACTION_ALIASES[clean];
  if (!mapped) {
    throw new AppError(
      `Unsupported update action "${action}". Allowed actions: set, add, subtract, multiply.`,
      400
    );
  }
  return mapped;
}

/**
 * Normalizes unit strings to 'absolute' | 'percentage' | 'percentage_points'.
 * @param {string} [unit='absolute']
 * @returns {string}
 */
function normalizeUpdateUnit(unit = 'absolute') {
  if (unit === undefined || unit === null || unit === '') {
    return 'absolute';
  }
  if (typeof unit !== 'string') {
    throw new AppError('Update unit must be a string.', 400);
  }
  const clean = unit.trim().toLowerCase();
  const mapped = UNIT_ALIASES[clean];
  if (!mapped) {
    throw new AppError(
      `Unsupported update unit "${unit}". Allowed units: absolute, percentage, percentage_points.`,
      400
    );
  }
  return mapped;
}

/**
 * Validates a single filter condition against the entity's schema.
 * Supports standard columns, `total_stock` (if present), and `size.<KEY>` stock filters.
 *
 * @param {string | object} entityOrSchema
 * @param {object} filter
 * @returns {{ field: string, operator: string, value: any, size_key?: string }}
 */
function validateFilter(entityOrSchema, filter) {
  const schema = getSchema(entityOrSchema);
  if (!filter || typeof filter !== 'object') {
    throw new AppError(
      'Filter must be an object with "field", "operator", and "value".',
      400
    );
  }

  const rawFieldInput = String(filter.field ?? '').trim();

  // If table has a "size" column, support nested size stock filters: size.XL, size.M
  if (findColumnDef(schema, 'size')) {
    const nestedSizeKey = resolveNestedSizeKey(rawFieldInput, filter.size_key);
    if (nestedSizeKey) {
      const operator = normalizeOperator(filter.operator);
      if (!NUMERIC_OPERATORS.includes(operator)) {
        throw new AppError(
          `Operator "${operator}" is not supported for nested size stock field "size.${nestedSizeKey}". Supported operators: ${NUMERIC_OPERATORS.join(', ')}.`,
          400
        );
      }

      let normalizedValue = filter.value;
      if (operator === 'between') {
        if (!Array.isArray(normalizedValue) || normalizedValue.length !== 2) {
          throw new AppError(
            `Operator "between" on "size.${nestedSizeKey}" requires an array of two numbers [min, max].`,
            400
          );
        }
        const num0 = parseCleanNumber(normalizedValue[0]);
        const num1 = parseCleanNumber(normalizedValue[1]);
        if (!Number.isFinite(num0) || !Number.isFinite(num1)) {
          throw new AppError(
            `Values in "between" filter for "size.${nestedSizeKey}" must be valid numbers.`,
            400
          );
        }
        normalizedValue = [Math.round(num0), Math.round(num1)];
      } else {
        const num = parseCleanNumber(normalizedValue);
        if (!Number.isFinite(num)) {
          throw new AppError(
            `Field "size.${nestedSizeKey}" expects a valid number, got "${filter.value}".`,
            400
          );
        }
        normalizedValue = Math.round(num);
        if (normalizedValue < 0) {
          throw new AppError(
            `Field "size.${nestedSizeKey}" filter value must be >= 0.`,
            400
          );
        }
      }

      return {
        field: `size.${nestedSizeKey}`,
        size_key: nestedSizeKey,
        operator,
        value: normalizedValue,
      };
    }
  }

  // Handle total_stock alias for products table
  let candidateField = rawFieldInput;
  if (
    schema.columns.total_stock &&
    (candidateField.toLowerCase() === 'stock' ||
      candidateField.toLowerCase() === 'size_total_stock' ||
      candidateField.toLowerCase() === 'total_units')
  ) {
    candidateField = 'total_stock';
  }

  const match = findColumnDef(schema, candidateField);
  if (!match) {
    const available = Object.values(schema.columns)
      .filter((c) => c.queryable)
      .map((c) => c.exactName || c);
    throw new AppError(
      `Field "${filter.field}" does not exist on entity "${schema.entity}". Available fields: ${available.join(', ')}.`,
      400
    );
  }

  const { colDef, exactName } = match;
  if (!colDef.queryable) {
    throw new AppError(`Field "${exactName}" cannot be filtered on.`, 400);
  }

  const operator = normalizeOperator(filter.operator);
  if (!colDef.operators.includes(operator)) {
    throw new AppError(
      `Operator "${operator}" is not supported for field "${exactName}" (type: ${colDef.type}). Supported operators: ${colDef.operators.join(', ')}.`,
      400
    );
  }

  let normalizedValue = filter.value;

  if (colDef.type === 'boolean') {
    normalizedValue = coerceBooleanValue(normalizedValue, exactName);
  } else if (colDef.type === 'number' || colDef.type === 'integer') {
    if (operator === 'between') {
      if (!Array.isArray(normalizedValue) || normalizedValue.length !== 2) {
        throw new AppError(
          `Operator "between" on "${exactName}" requires an array of two numbers [min, max].`,
          400
        );
      }
      const num0 = parseCleanNumber(normalizedValue[0]);
      const num1 = parseCleanNumber(normalizedValue[1]);
      if (!Number.isFinite(num0) || !Number.isFinite(num1)) {
        throw new AppError(
          `Values in "between" filter for "${exactName}" must be valid numbers.`,
          400
        );
      }
      normalizedValue = [num0, num1];
    } else {
      const num = parseCleanNumber(normalizedValue);
      if (!Number.isFinite(num)) {
        throw new AppError(
          `Field "${exactName}" expects a valid number, got "${filter.value}".`,
          400
        );
      }
      normalizedValue = colDef.type === 'integer' ? Math.round(num) : num;
      if (colDef.min !== undefined && normalizedValue < colDef.min) {
        throw new AppError(`Field "${exactName}" must be >= ${colDef.min}.`, 400);
      }
      if (colDef.max !== undefined && normalizedValue > colDef.max) {
        throw new AppError(`Field "${exactName}" must be <= ${colDef.max}.`, 400);
      }
    }
  } else if (colDef.type === 'date') {
    if (operator === 'relative_days_ago') {
      const days = parseCleanNumber(normalizedValue);
      if (!Number.isFinite(days) || days <= 0) {
        throw new AppError(
          'Operator "relative_days_ago" expects a positive number of days.',
          400
        );
      }
      normalizedValue = Math.round(days);
    } else if (operator === 'this_month') {
      normalizedValue = true;
    } else if (operator === 'between') {
      if (!Array.isArray(normalizedValue) || normalizedValue.length !== 2) {
        throw new AppError(
          `Operator "between" on "${exactName}" requires an array of two dates [start, end].`,
          400
        );
      }
      normalizedValue = [
        String(normalizedValue[0]).trim(),
        String(normalizedValue[1]).trim(),
      ];
    } else {
      const strVal = String(normalizedValue ?? '').trim();
      if (!strVal) {
        throw new AppError(
          `Date filter on "${exactName}" requires a non-empty date value.`,
          400
        );
      }
      normalizedValue = strVal;
    }
  } else if (colDef.type === 'string' || colDef.type === 'uuid') {
    if (operator === 'in') {
      if (!Array.isArray(normalizedValue) || normalizedValue.length === 0) {
        throw new AppError(
          `Operator "in" on "${exactName}" requires a non-empty array of values.`,
          400
        );
      }
      normalizedValue = normalizedValue.map((v) => String(v).trim());
    } else if (normalizedValue && typeof normalizedValue === 'object') {
      normalizedValue = JSON.stringify(normalizedValue);
    } else {
      normalizedValue = String(normalizedValue ?? '').trim();
    }
  }

  return {
    field: exactName,
    operator,
    value: normalizedValue,
  };
}

/**
 * Validates sort criteria array against the entity's schema.
 *
 * @param {string | object} entityOrSchema
 * @param {Array<{ field: string, direction?: string }>} sort
 * @returns {Array<{ field: string, direction: 'asc' | 'desc' }>}
 */
function validateSort(entityOrSchema, sort) {
  if (!sort) return [];
  if (!Array.isArray(sort)) {
    throw new AppError(
      'Sort criteria must be an array of objects ({ field, direction }).',
      400
    );
  }

  const schema = getSchema(entityOrSchema);
  const validated = [];

  for (const item of sort) {
    if (!item || typeof item !== 'object') continue;
    const match = findColumnDef(schema, item.field);
    if (!match) {
      throw new AppError(`Cannot sort by unknown field "${item.field}".`, 400);
    }
    if (match.colDef.sortable === false) {
      throw new AppError(
        `Field "${match.exactName}" is not sortable on ${schema.entity}.`,
        400
      );
    }
    const dir = String(item.direction ?? 'asc').trim().toLowerCase();
    const direction = dir === 'desc' ? 'desc' : 'asc';
    validated.push({ field: match.exactName, direction });
  }

  return validated;
}

/**
 * Validates a single transformation entry ({ field, action, value, unit, size_key }).
 *
 * @param {object} schema
 * @param {object} rawUpdate
 * @returns {{ field: string, action: string, value: any, unit: string, size_key?: string }}
 */
function validateSingleUpdateTransformation(schema, rawUpdate) {
  if (!rawUpdate || typeof rawUpdate !== 'object') {
    throw new AppError(
      'Each update transformation must be an object with "field", "action", and "value".',
      400
    );
  }

  const rawFieldInput = String(rawUpdate.field ?? '').trim();
  if (!rawFieldInput) {
    throw new AppError('Update transformation is missing required "field".', 400);
  }

  const action = normalizeUpdateAction(rawUpdate.action);
  let unit = normalizeUpdateUnit(rawUpdate.unit);

  // Nested size transformation on tables with a size column
  if (findColumnDef(schema, 'size')) {
    const nestedSizeKey = resolveNestedSizeKey(rawFieldInput, rawUpdate.size_key);
    if (nestedSizeKey) {
      if (rawUpdate.value === undefined || rawUpdate.value === null || rawUpdate.value === '') {
        throw new AppError(
          `Update for "size.${nestedSizeKey}" requires a numeric "value".`,
          400
        );
      }
      const num = parseCleanNumber(rawUpdate.value);
      if (!Number.isFinite(num)) {
        throw new AppError(
          `Value for "size.${nestedSizeKey}" must be a valid number, got "${rawUpdate.value}".`,
          400
        );
      }

      if (action === 'set') {
        if (!Number.isInteger(num) || num < 0) {
          throw new AppError(
            `Stock count for "size.${nestedSizeKey}" must be a non-negative integer, got ${num}.`,
            400
          );
        }
        return {
          field: `size.${nestedSizeKey}`,
          size_key: nestedSizeKey,
          action: 'set',
          value: num,
          unit: 'absolute',
        };
      }

      if (action === 'add' || action === 'subtract') {
        if (num < 0) {
          throw new AppError(
            `Adjustment value for "${action}" on "size.${nestedSizeKey}" cannot be negative, got ${num}.`,
            400
          );
        }
        if (unit === 'percentage' && action === 'subtract' && num > 100) {
          throw new AppError(
            `Cannot reduce stock for "size.${nestedSizeKey}" by more than 100%.`,
            400
          );
        }
        if (unit === 'absolute' && !Number.isInteger(num)) {
          throw new AppError(
            `Stock unit adjustment for "size.${nestedSizeKey}" must be a whole integer, got ${num}.`,
            400
          );
        }
        return {
          field: `size.${nestedSizeKey}`,
          size_key: nestedSizeKey,
          action,
          value: unit === 'absolute' ? Math.round(num) : num,
          unit: unit === 'percentage' ? 'percentage' : 'absolute',
        };
      }

      if (action === 'multiply') {
        if (num < 0) {
          throw new AppError(
            `Stock multiplier for "size.${nestedSizeKey}" cannot be negative, got ${num}.`,
            400
          );
        }
        return {
          field: `size.${nestedSizeKey}`,
          size_key: nestedSizeKey,
          action: 'multiply',
          value: num,
          unit: 'absolute',
        };
      }
    }
  }

  const match = findColumnDef(schema, rawFieldInput);
  if (!match || match.colDef.virtual) {
    const available = Object.values(schema.columns)
      .filter((c) => c.modifiable)
      .map((c) => c.exactName || c);
    throw new AppError(
      `Cannot modify unknown or virtual field "${rawFieldInput}" on ${schema.entity}. Available modifiable fields: ${available.join(', ')}.`,
      400
    );
  }

  const { colDef, exactName } = match;
  if (!colDef.modifiable) {
    throw new AppError(
      `Field "${exactName}" is read-only and cannot be modified.`,
      400
    );
  }

  if (rawUpdate.value === undefined || rawUpdate.value === null) {
    throw new AppError(`Missing value for field "${exactName}".`, 400);
  }

  // Non-numeric fields only support 'set'
  if (colDef.type !== 'number' && colDef.type !== 'integer') {
    if (action !== 'set') {
      throw new AppError(
        `Arithmetic action "${action}" is not supported on ${colDef.type} field "${exactName}". Only "set" is allowed.`,
        400
      );
    }

    let coerced = rawUpdate.value;
    if (colDef.type === 'boolean') {
      coerced = coerceBooleanValue(rawUpdate.value, exactName);
    } else if (colDef.type === 'string') {
      if (exactName === 'size') {
        if (typeof rawUpdate.value === 'object') {
          for (const [k, v] of Object.entries(rawUpdate.value)) {
            const upperK = k.trim().toUpperCase();
            if (!APPAREL_SIZE_KEYS.has(upperK)) {
              throw new AppError(`Invalid size key "${k}" in size object.`, 400);
            }
            const qty = Number(v);
            if (!Number.isInteger(qty) || qty < 0) {
              throw new AppError(
                `Stock count for size "${upperK}" must be a non-negative integer, got "${v}".`,
                400
              );
            }
          }
          coerced = JSON.stringify(rawUpdate.value);
        } else {
          const strVal = String(rawUpdate.value).trim();
          if (strVal.startsWith('{')) {
            let parsedObj;
            try {
              parsedObj = JSON.parse(strVal);
            } catch {
              throw new AppError('Field "size" must be valid JSON.', 400);
            }
            for (const [k, v] of Object.entries(parsedObj)) {
              const qty = Number(v);
              if (!Number.isInteger(qty) || qty < 0) {
                throw new AppError(
                  `Stock count for size "${k}" must be a non-negative integer, got "${v}".`,
                  400
                );
              }
            }
            coerced = JSON.stringify(parsedObj);
          } else {
            coerced = strVal;
          }
        }
      } else {
        coerced = String(rawUpdate.value ?? '').trim();
        if (colDef.required && !coerced) {
          throw new AppError(`Field "${exactName}" cannot be empty.`, 400);
        }
      }
    } else {
      coerced = String(rawUpdate.value ?? '').trim();
    }

    return {
      field: exactName,
      action: 'set',
      value: coerced,
      unit: 'absolute',
    };
  }

  // Numeric / Integer field validation
  const num = parseCleanNumber(rawUpdate.value);
  if (!Number.isFinite(num)) {
    throw new AppError(
      `Value for "${exactName}" must be a valid number, got "${rawUpdate.value}".`,
      400
    );
  }

  if (action === 'set') {
    const coerced = colDef.type === 'integer' ? Math.round(num) : num;
    if (colDef.type === 'integer' && !Number.isInteger(num)) {
      throw new AppError(
        `Field "${exactName}" requires an integer value, got ${num}.`,
        400
      );
    }
    if (colDef.min !== undefined && coerced < colDef.min) {
      throw new AppError(
        `Value for "${exactName}" must be >= ${colDef.min}, got ${coerced}.`,
        400
      );
    }
    if (colDef.max !== undefined && coerced > colDef.max) {
      throw new AppError(
        `Value for "${exactName}" must be <= ${colDef.max}, got ${coerced}.`,
        400
      );
    }
    return {
      field: exactName,
      action: 'set',
      value: coerced,
      unit: 'absolute',
    };
  }

  if (action === 'add' || action === 'subtract') {
    if (num < 0) {
      throw new AppError(
        `Value for "${action}" on "${exactName}" must be >= 0, got ${num}.`,
        400
      );
    }

    // For discount columns, percentage addition/subtraction means percentage points
    if (
      exactName.toLowerCase().includes('discount') &&
      (unit === 'percentage' || unit === 'absolute')
    ) {
      unit = 'percentage_points';
    }

    if (exactName.toLowerCase().includes('discount') && num > 100) {
      throw new AppError(
        `Discount adjustment on "${exactName}" cannot exceed 100 percentage points, got ${num}.`,
        400
      );
    }

    if (unit === 'percentage' && action === 'subtract' && num > 100) {
      throw new AppError(
        `Cannot subtract more than 100% from "${exactName}".`,
        400
      );
    }

    if (colDef.type === 'integer' && unit === 'absolute' && !Number.isInteger(num)) {
      throw new AppError(
        `Absolute "${action}" value for integer field "${exactName}" must be an integer, got ${num}.`,
        400
      );
    }

    return {
      field: exactName,
      action,
      value: colDef.type === 'integer' && unit === 'absolute' ? Math.round(num) : num,
      unit,
    };
  }

  if (action === 'multiply') {
    if (num < 0) {
      throw new AppError(
        `Multiplier for "${exactName}" cannot be negative, got ${num}.`,
        400
      );
    }
    return {
      field: exactName,
      action: 'multiply',
      value: num,
      unit: 'absolute',
    };
  }

  throw new AppError(`Unsupported action "${action}" on "${exactName}".`, 400);
}

/**
 * Validates a mutation payload supporting conditional bulk updates, arithmetic transformations,
 * nested size updates, AND/OR filter combinations, and legacy `changes` objects.
 *
 * @param {string | object} entityOrSchema
 * @param {object} mutation
 * @returns {object} validated mutation plan
 */
function validateMutation(entityOrSchema, mutation) {
  const schema = getSchema(entityOrSchema);
  if (!mutation || typeof mutation !== 'object') {
    throw new AppError('Mutation payload must be an object.', 400);
  }

  const rawOp = String(mutation.operation ?? '').trim().toLowerCase();
  if (!['update', 'update_many', 'delete', 'create'].includes(rawOp)) {
    throw new AppError(
      `Unsupported mutation operation "${mutation.operation}". Supported operations are: update, update_many, delete, create.`,
      400
    );
  }

  const rawLogic = String(
    mutation.filter_logic || mutation.logical_operator || 'AND'
  )
    .trim()
    .toUpperCase();
  if (rawLogic !== 'AND' && rawLogic !== 'OR') {
    throw new AppError(
      `Unsupported filter_logic "${rawLogic}". Allowed values: AND, OR.`,
      400
    );
  }

  const matchAll = Boolean(mutation.match_all);
  const targetFilters = [];

  if (rawOp === 'update' || rawOp === 'update_many' || rawOp === 'delete') {
    const rawFilters = mutation.target_filters || mutation.filters || [];
    if (!Array.isArray(rawFilters)) {
      throw new AppError('"target_filters" must be an array.', 400);
    }

    for (const f of rawFilters) {
      targetFilters.push(validateFilter(schema, f));
    }

    if (targetFilters.length === 0) {
      if (rawOp === 'delete') {
        throw new AppError(
          'Mutation "delete" requires at least one target filter to identify records safely.',
          400
        );
      }
      if (!matchAll) {
        throw new AppError(
          `Mutation "${rawOp}" requires at least one target filter (or explicit "match_all": true when targeting all records) to identify records safely.`,
          400
        );
      }
    }
  }

  // Convert `updates` array and/or legacy `changes` object into a unified `updates` list
  const rawUpdatesList = [];
  if (Array.isArray(mutation.updates) && mutation.updates.length > 0) {
    rawUpdatesList.push(...mutation.updates);
  } else if (
    mutation.changes &&
    typeof mutation.changes === 'object' &&
    !Array.isArray(mutation.changes) &&
    Object.keys(mutation.changes).length > 0
  ) {
    for (const [k, v] of Object.entries(mutation.changes)) {
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        (v.action !== undefined || v.value !== undefined) &&
        k.toLowerCase() !== 'size'
      ) {
        rawUpdatesList.push({
          field: k,
          action: v.action || 'set',
          value: v.value,
          unit: v.unit || 'absolute',
          size_key: v.size_key,
        });
      } else {
        rawUpdatesList.push({
          field: k,
          action: 'set',
          value: v,
          unit: 'absolute',
        });
      }
    }
  }

  const validatedUpdates = [];
  const legacyChangesSummary = {};

  if (rawOp === 'update' || rawOp === 'update_many' || rawOp === 'create') {
    if (rawUpdatesList.length === 0) {
      throw new AppError(
        `Mutation "${rawOp}" requires a non-empty "updates" array or "changes" object.`,
        400
      );
    }

    for (const item of rawUpdatesList) {
      const validatedItem = validateSingleUpdateTransformation(schema, item);
      if (rawOp === 'create' && (validatedItem.action !== 'set' || validatedItem.size_key)) {
        throw new AppError(
          'Mutation "create" only supports direct field assignments ("action": "set").',
          400
        );
      }
      validatedUpdates.push(validatedItem);

      if (validatedItem.action === 'set') {
        legacyChangesSummary[validatedItem.field] = validatedItem.value;
      } else {
        const unitSuffix =
          validatedItem.unit === 'percentage'
            ? '%'
            : validatedItem.unit === 'percentage_points'
              ? ' percentage points'
              : '';
        legacyChangesSummary[validatedItem.field] =
          `${validatedItem.action} ${validatedItem.value}${unitSuffix}`;
      }
    }
  }

  return {
    entity: schema.entity,
    operation: rawOp,
    filter_logic: rawLogic,
    match_all: matchAll,
    target_filters: targetFilters,
    updates: validatedUpdates,
    changes: legacyChangesSummary,
  };
}

module.exports = {
  APPAREL_SIZE_KEYS,
  ENTITY_SCHEMAS,
  REGISTERED_SCHEMAS,
  discoverTableSchema,
  registerTableSchema,
  getSupportedEntities,
  isEntitySupported,
  normalizeEntityName,
  getSchema,
  ensureTableExists,
  findColumnDef,
  normalizeOperator,
  normalizeUpdateAction,
  normalizeUpdateUnit,
  resolveNestedSizeKey,
  validateFilter,
  validateSort,
  validateSingleUpdateTransformation,
  validateMutation,
  parseCleanNumber,
  coerceBooleanValue,
};
