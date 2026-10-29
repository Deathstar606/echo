const AppError = require('../utils/AppError');

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

/**
 * Canonical Schema definition for the single supported entity ('products'),
 * matching the structure of backend/products.csv:
 * name, category, description, best, color, discount, ordered, images, size, price
 */
const ENTITY_SCHEMAS = {
  products: {
    entity: 'products',
    tableName: 'products',
    displayName: 'Products',
    columns: {
      id: {
        type: 'uuid',
        readonly: true,
        queryable: true,
        modifiable: false,
        sortable: false,
        operators: ['equals', 'not_equals', 'in'],
      },
      business_id: { type: 'uuid', readonly: true },
      name: {
        type: 'string',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: [
          'equals',
          'not_equals',
          'contains',
          'not_contains',
          'starts_with',
          'ends_with',
          'in',
        ],
      },
      category: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: [
          'equals',
          'not_equals',
          'contains',
          'not_contains',
          'starts_with',
          'ends_with',
          'in',
        ],
      },
      description: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: false,
        operators: ['contains', 'not_contains', 'equals', 'not_equals'],
      },
      best: {
        type: 'boolean',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: ['equals', 'not_equals'],
      },
      color: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: [
          'equals',
          'not_equals',
          'contains',
          'not_contains',
          'in',
        ],
      },
      discount: {
        type: 'number',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        max: 100,
        operators: [
          'equals',
          'not_equals',
          'greater_than',
          'greater_than_or_equal',
          'less_than',
          'less_than_or_equal',
          'between',
        ],
      },
      ordered: {
        type: 'integer',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: [
          'equals',
          'not_equals',
          'greater_than',
          'greater_than_or_equal',
          'less_than',
          'less_than_or_equal',
          'between',
        ],
      },
      images: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: false,
        operators: ['equals', 'not_equals', 'contains', 'not_contains'],
      },
      size: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: false,
        operators: [
          'equals',
          'not_equals',
          'contains',
          'not_contains',
          'in',
        ],
      },
      price: {
        type: 'number',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: [
          'equals',
          'not_equals',
          'greater_than',
          'greater_than_or_equal',
          'less_than',
          'less_than_or_equal',
          'between',
        ],
      },
      total_stock: {
        type: 'integer',
        virtual: true,
        required: false,
        queryable: true,
        modifiable: false,
        sortable: false,
        min: 0,
        description:
          'Computed sum of stock quantities across all sizes in the JSON "size" column',
        operators: [
          'equals',
          'not_equals',
          'greater_than',
          'greater_than_or_equal',
          'less_than',
          'less_than_or_equal',
          'between',
        ],
      },
      created_at: {
        type: 'date',
        required: false,
        queryable: true,
        modifiable: false,
        sortable: true,
        operators: [
          'equals',
          'greater_than',
          'greater_than_or_equal',
          'less_than',
          'less_than_or_equal',
          'between',
          'relative_days_ago',
          'this_month',
        ],
      },
      updated_at: { type: 'date', readonly: true },
    },
  },
};

const NUMERIC_OPERATORS = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'between',
];

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
 * Parses a nested size field specifier such as "size.M", "size.XL", or { field: "size", size_key: "M" }.
 * Returns the uppercase size key if valid, or null if not a nested size reference.
 * Throws AppError if it references an invalid size key.
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
 * Returns supported entity names.
 * @returns {string[]}
 */
function getSupportedEntities() {
  return Object.keys(ENTITY_SCHEMAS);
}

/**
 * Checks whether an entity name is supported.
 * @param {string} entity
 * @returns {boolean}
 */
function isEntitySupported(entity) {
  if (typeof entity !== 'string') return false;
  const clean = entity.trim().toLowerCase();
  return clean === 'product' || clean === 'products';
}

/**
 * Normalizes entity name ('product' | 'products' -> 'products').
 * Rejects 'services' or any other unsupported entity.
 *
 * @param {string} [entity='products']
 * @returns {string}
 */
function normalizeEntityName(entity = 'products') {
  if (entity === undefined || entity === null || entity === '') {
    return 'products';
  }
  if (typeof entity !== 'string') {
    throw new AppError('Entity name must be a string.', 400);
  }
  const clean = entity.trim().toLowerCase();
  if (clean === 'product' || clean === 'products') return 'products';
  throw new AppError(
    `Unknown entity "${entity}". Supported entity is: products.`,
    400
  );
}

/**
 * Returns the schema definition for the specified entity.
 * @param {string} [entity='products']
 * @returns {object}
 */
function getSchema(entity = 'products') {
  const norm = normalizeEntityName(entity);
  return ENTITY_SCHEMAS[norm];
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
 * Supports standard columns, `total_stock` (aliased from `stock`), and `size.<KEY>` stock filters.
 * Throws AppError if invalid.
 *
 * @param {string} entity
 * @param {object} filter
 * @returns {{ field: string, operator: string, value: any, size_key?: string }}
 */
function validateFilter(entity, filter) {
  const schema = getSchema(entity);
  if (!filter || typeof filter !== 'object') {
    throw new AppError(
      'Filter must be an object with "field", "operator", and "value".',
      400
    );
  }

  const rawFieldInput = String(filter.field ?? '').trim();
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

  let rawField = rawFieldInput.toLowerCase();
  if (rawField === 'stock' || rawField === 'size_total_stock' || rawField === 'total_units') {
    rawField = 'total_stock';
  }

  if (!rawField || !schema.columns[rawField]) {
    throw new AppError(
      `Field "${filter.field}" does not exist on entity "${schema.entity}". Available fields: ${Object.keys(
        schema.columns
      )
        .filter((c) => schema.columns[c].queryable)
        .join(', ')}, size.<SIZE_KEY>.`,
      400
    );
  }

  const colDef = schema.columns[rawField];
  if (!colDef.queryable) {
    throw new AppError(`Field "${rawField}" cannot be filtered on.`, 400);
  }

  const operator = normalizeOperator(filter.operator);
  if (!colDef.operators.includes(operator)) {
    throw new AppError(
      `Operator "${operator}" is not supported for field "${rawField}" (type: ${colDef.type}). Supported operators: ${colDef.operators.join(', ')}.`,
      400
    );
  }

  let normalizedValue = filter.value;

  if (colDef.type === 'boolean') {
    normalizedValue = coerceBooleanValue(normalizedValue, rawField);
  } else if (colDef.type === 'number' || colDef.type === 'integer') {
    if (operator === 'between') {
      if (!Array.isArray(normalizedValue) || normalizedValue.length !== 2) {
        throw new AppError(
          `Operator "between" on "${rawField}" requires an array of two numbers [min, max].`,
          400
        );
      }
      const num0 = parseCleanNumber(normalizedValue[0]);
      const num1 = parseCleanNumber(normalizedValue[1]);
      if (!Number.isFinite(num0) || !Number.isFinite(num1)) {
        throw new AppError(
          `Values in "between" filter for "${rawField}" must be valid numbers.`,
          400
        );
      }
      normalizedValue = [num0, num1];
    } else {
      const num = parseCleanNumber(normalizedValue);
      if (!Number.isFinite(num)) {
        throw new AppError(
          `Field "${rawField}" expects a valid number, got "${filter.value}".`,
          400
        );
      }
      normalizedValue = colDef.type === 'integer' ? Math.round(num) : num;
      if (colDef.min !== undefined && normalizedValue < colDef.min) {
        throw new AppError(`Field "${rawField}" must be >= ${colDef.min}.`, 400);
      }
      if (colDef.max !== undefined && normalizedValue > colDef.max) {
        throw new AppError(`Field "${rawField}" must be <= ${colDef.max}.`, 400);
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
          `Operator "between" on "${rawField}" requires an array of two dates [start, end].`,
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
          `Date filter on "${rawField}" requires a non-empty date value.`,
          400
        );
      }
      normalizedValue = strVal;
    }
  } else if (colDef.type === 'string' || colDef.type === 'uuid') {
    if (operator === 'in') {
      if (!Array.isArray(normalizedValue) || normalizedValue.length === 0) {
        throw new AppError(
          `Operator "in" on "${rawField}" requires a non-empty array of values.`,
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
    field: rawField,
    operator,
    value: normalizedValue,
  };
}

/**
 * Validates sort criteria array.
 * @param {string} entity
 * @param {Array<{ field: string, direction?: string }>} sort
 * @returns {Array<{ field: string, direction: 'asc' | 'desc' }>}
 */
function validateSort(entity, sort) {
  if (!sort) return [];
  if (!Array.isArray(sort)) {
    throw new AppError(
      'Sort criteria must be an array of objects ({ field, direction }).',
      400
    );
  }

  const schema = getSchema(entity);
  const validated = [];

  for (const item of sort) {
    if (!item || typeof item !== 'object') continue;
    const rawField = String(item.field ?? '').trim().toLowerCase();
    if (!rawField || !schema.columns[rawField]) {
      throw new AppError(`Cannot sort by unknown field "${item.field}".`, 400);
    }
    if (!schema.columns[rawField].sortable) {
      throw new AppError(
        `Field "${rawField}" is not sortable on ${schema.entity}.`,
        400
      );
    }
    const dir = String(item.direction ?? 'asc').trim().toLowerCase();
    const direction = dir === 'desc' ? 'desc' : 'asc';
    validated.push({ field: rawField, direction });
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

  // Check if this is a nested size stock transformation (e.g. "size.M" or { field: "size", size_key: "M" })
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

  const fieldName = rawFieldInput.toLowerCase();
  const colDef = schema.columns[fieldName];
  if (!colDef || colDef.virtual) {
    throw new AppError(
      `Cannot modify unknown or virtual field "${rawFieldInput}" on ${schema.entity}. Available modifiable fields: ${Object.keys(
        schema.columns
      )
        .filter((c) => schema.columns[c].modifiable)
        .join(', ')}, size.<SIZE_KEY>.`,
      400
    );
  }
  if (!colDef.modifiable) {
    throw new AppError(
      `Field "${fieldName}" is read-only and cannot be modified.`,
      400
    );
  }

  if (rawUpdate.value === undefined || rawUpdate.value === null) {
    throw new AppError(`Missing value for field "${fieldName}".`, 400);
  }

  // Non-numeric fields only support 'set'
  if (colDef.type !== 'number' && colDef.type !== 'integer') {
    if (action !== 'set') {
      throw new AppError(
        `Arithmetic action "${action}" is not supported on ${colDef.type} field "${fieldName}". Only "set" is allowed.`,
        400
      );
    }

    let coerced = rawUpdate.value;
    if (colDef.type === 'boolean') {
      coerced = coerceBooleanValue(rawUpdate.value, fieldName);
    } else if (colDef.type === 'string') {
      if (fieldName === 'size') {
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
          throw new AppError(`Field "${fieldName}" cannot be empty.`, 400);
        }
      }
    } else {
      coerced = String(rawUpdate.value ?? '').trim();
    }

    return {
      field: fieldName,
      action: 'set',
      value: coerced,
      unit: 'absolute',
    };
  }

  // Numeric / Integer field validation
  const num = parseCleanNumber(rawUpdate.value);
  if (!Number.isFinite(num)) {
    throw new AppError(
      `Value for "${fieldName}" must be a valid number, got "${rawUpdate.value}".`,
      400
    );
  }

  if (action === 'set') {
    const coerced = colDef.type === 'integer' ? Math.round(num) : num;
    if (colDef.type === 'integer' && !Number.isInteger(num)) {
      throw new AppError(
        `Field "${fieldName}" requires an integer value, got ${num}.`,
        400
      );
    }
    if (colDef.min !== undefined && coerced < colDef.min) {
      throw new AppError(
        `Value for "${fieldName}" must be >= ${colDef.min}, got ${coerced}.`,
        400
      );
    }
    if (colDef.max !== undefined && coerced > colDef.max) {
      throw new AppError(
        `Value for "${fieldName}" must be <= ${colDef.max}, got ${coerced}.`,
        400
      );
    }
    return {
      field: fieldName,
      action: 'set',
      value: coerced,
      unit: 'absolute',
    };
  }

  if (action === 'add' || action === 'subtract') {
    if (num < 0) {
      throw new AppError(
        `Value for "${action}" on "${fieldName}" must be >= 0, got ${num}.`,
        400
      );
    }

    // For discount, adding/subtracting a percentage means percentage points (e.g. +5% -> 20 to 25)
    if (fieldName === 'discount' && (unit === 'percentage' || unit === 'absolute')) {
      unit = 'percentage_points';
    }

    if (fieldName === 'discount' && num > 100) {
      throw new AppError(
        `Discount adjustment on "discount" cannot exceed 100 percentage points, got ${num}.`,
        400
      );
    }

    if (unit === 'percentage' && action === 'subtract' && num > 100) {
      throw new AppError(
        `Cannot subtract more than 100% from "${fieldName}".`,
        400
      );
    }

    if (colDef.type === 'integer' && unit === 'absolute' && !Number.isInteger(num)) {
      throw new AppError(
        `Absolute "${action}" value for integer field "${fieldName}" must be an integer, got ${num}.`,
        400
      );
    }

    return {
      field: fieldName,
      action,
      value: colDef.type === 'integer' && unit === 'absolute' ? Math.round(num) : num,
      unit,
    };
  }

  if (action === 'multiply') {
    if (num < 0) {
      throw new AppError(
        `Multiplier for "${fieldName}" cannot be negative, got ${num}.`,
        400
      );
    }
    return {
      field: fieldName,
      action: 'multiply',
      value: num,
      unit: 'absolute',
    };
  }

  throw new AppError(`Unsupported action "${action}" on "${fieldName}".`, 400);
}

/**
 * Validates a mutation payload supporting conditional bulk updates, arithmetic transformations,
 * nested size updates, AND/OR filter combinations, and legacy `changes` objects.
 *
 * @param {string} entity
 * @param {object} mutation
 * @returns {object} validated mutation plan
 */
function validateMutation(entity, mutation) {
  const schema = getSchema(entity);
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
      targetFilters.push(validateFilter(schema.entity, f));
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
          `Mutation "${rawOp}" requires at least one target filter (or explicit "match_all": true when targeting all products) to identify records safely.`,
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
  getSupportedEntities,
  isEntitySupported,
  normalizeEntityName,
  getSchema,
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
