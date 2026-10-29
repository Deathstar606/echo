const AppError = require('../utils/AppError');

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
      id: { type: 'uuid', readonly: true },
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
  on_or_after: 'greater_than_or_equal',
  '<': 'less_than',
  lt: 'less_than',
  before: 'less_than',
  '<=': 'less_than_or_equal',
  lte: 'less_than_or_equal',
  on_or_before: 'less_than_or_equal',
  like: 'contains',
  ilike: 'contains',
  match: 'contains',
  includes: 'contains',
  has: 'contains',
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
 * Validates a single filter condition against the entity's schema.
 * Throws AppError if invalid.
 *
 * @param {string} entity
 * @param {object} filter
 * @returns {{ field: string, operator: string, value: any }}
 */
function validateFilter(entity, filter) {
  const schema = getSchema(entity);
  if (!filter || typeof filter !== 'object') {
    throw new AppError(
      'Filter must be an object with "field", "operator", and "value".',
      400
    );
  }

  const rawField = String(filter.field ?? '').trim().toLowerCase();
  if (!rawField || !schema.columns[rawField]) {
    throw new AppError(
      `Field "${filter.field}" does not exist on entity "${schema.entity}". Available fields: ${Object.keys(
        schema.columns
      )
        .filter((c) => schema.columns[c].queryable)
        .join(', ')}.`,
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
  } else if (colDef.type === 'string') {
    if (operator === 'in') {
      if (!Array.isArray(normalizedValue)) {
        throw new AppError(
          `Operator "in" on "${rawField}" requires an array of values.`,
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
 * Validates a mutation payload ({ operation, target_filters, changes }).
 * @param {string} entity
 * @param {object} mutation
 * @returns {object} validated mutation
 */
function validateMutation(entity, mutation) {
  const schema = getSchema(entity);
  if (!mutation || typeof mutation !== 'object') {
    throw new AppError('Mutation payload must be an object.', 400);
  }

  const operation = String(mutation.operation ?? '').trim().toLowerCase();
  if (!['update', 'delete', 'create'].includes(operation)) {
    throw new AppError(
      `Unsupported mutation operation "${mutation.operation}". Supported operations are: update, delete, create.`,
      400
    );
  }

  const targetFilters = [];
  if (operation === 'update' || operation === 'delete') {
    const rawFilters = mutation.target_filters || mutation.filters || [];
    if (!Array.isArray(rawFilters) || rawFilters.length === 0) {
      throw new AppError(
        `Mutation "${operation}" requires at least one target filter (e.g. name or category) to identify records safely.`,
        400
      );
    }
    for (const f of rawFilters) {
      targetFilters.push(validateFilter(entity, f));
    }
  }

  const validatedChanges = {};
  if (operation === 'update' || operation === 'create') {
    const rawChanges = mutation.changes || {};
    if (typeof rawChanges !== 'object' || Object.keys(rawChanges).length === 0) {
      throw new AppError(
        `Mutation "${operation}" requires a non-empty "changes" object.`,
        400
      );
    }

    for (const [key, val] of Object.entries(rawChanges)) {
      const fieldName = key.trim().toLowerCase();
      const colDef = schema.columns[fieldName];
      if (!colDef) {
        throw new AppError(
          `Cannot modify unknown field "${key}" on ${schema.entity}. Available modifiable fields: ${Object.keys(
            schema.columns
          )
            .filter((c) => schema.columns[c].modifiable)
            .join(', ')}.`,
          400
        );
      }
      if (!colDef.modifiable) {
        throw new AppError(
          `Field "${fieldName}" is read-only and cannot be modified.`,
          400
        );
      }

      let coerced = val;
      if (colDef.type === 'boolean') {
        coerced = coerceBooleanValue(val, fieldName);
      } else if (colDef.type === 'number' || colDef.type === 'integer') {
        const num = parseCleanNumber(val);
        if (!Number.isFinite(num)) {
          throw new AppError(
            `Value for "${fieldName}" must be a valid number.`,
            400
          );
        }
        coerced = colDef.type === 'integer' ? Math.round(num) : num;
        if (colDef.min !== undefined && coerced < colDef.min) {
          throw new AppError(
            `Value for "${fieldName}" must be >= ${colDef.min}.`,
            400
          );
        }
      } else if (colDef.type === 'string') {
        if (fieldName === 'size' && val && typeof val === 'object') {
          coerced = JSON.stringify(val);
        } else {
          coerced = String(val ?? '').trim();
          if (colDef.required && !coerced) {
            throw new AppError(`Field "${fieldName}" cannot be empty.`, 400);
          }
        }
      } else if (colDef.type === 'date') {
        coerced = String(val ?? '').trim();
      }

      validatedChanges[fieldName] = coerced;
    }
  }

  return {
    entity: schema.entity,
    operation,
    target_filters: targetFilters,
    changes: validatedChanges,
  };
}

module.exports = {
  ENTITY_SCHEMAS,
  getSupportedEntities,
  isEntitySupported,
  normalizeEntityName,
  getSchema,
  normalizeOperator,
  validateFilter,
  validateSort,
  validateMutation,
};
