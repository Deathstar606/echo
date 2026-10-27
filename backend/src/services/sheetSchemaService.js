const AppError = require('../utils/AppError');

/**
 * Canonical Schema definitions for supported entities (products and services).
 * Exposes columns, types, allowed operators, and validation methods.
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
        operators: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in'],
      },
      description: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: false,
        operators: ['contains', 'not_contains', 'equals'],
      },
      price: {
        type: 'number',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'],
      },
      stock: {
        type: 'integer',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'],
      },
      category: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: ['equals', 'not_equals', 'contains', 'in'],
      },
      size: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: ['equals', 'not_equals', 'in'],
      },
      color: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: ['equals', 'not_equals', 'contains', 'in'],
      },
      created_at: {
        type: 'date',
        required: false,
        queryable: true,
        modifiable: false,
        sortable: true,
        operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between', 'relative_days_ago', 'this_month'],
      },
      updated_at: { type: 'date', readonly: true },
    },
  },
  services: {
    entity: 'services',
    tableName: 'services',
    displayName: 'Services',
    columns: {
      id: { type: 'uuid', readonly: true },
      business_id: { type: 'uuid', readonly: true },
      name: {
        type: 'string',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in'],
      },
      description: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: false,
        operators: ['contains', 'not_contains', 'equals'],
      },
      rate: {
        type: 'number',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        min: 0,
        operators: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'],
      },
      availability: {
        type: 'string',
        required: true,
        queryable: true,
        modifiable: true,
        sortable: true,
        allowedValues: ['available', 'unavailable'],
        operators: ['equals', 'not_equals', 'in'],
      },
      size: {
        type: 'string',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: ['equals', 'not_equals', 'in'],
      },
      available_from: {
        type: 'date',
        required: false,
        queryable: true,
        modifiable: true,
        sortable: true,
        operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between', 'after', 'before'],
      },
      created_at: {
        type: 'date',
        required: false,
        queryable: true,
        modifiable: false,
        sortable: true,
        operators: ['equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between', 'relative_days_ago', 'this_month'],
      },
      updated_at: { type: 'date', readonly: true },
    },
  },
};

const OPERATOR_ALIASES = {
  '=': 'equals',
  '==': 'equals',
  'eq': 'equals',
  '!=': 'not_equals',
  '<>': 'not_equals',
  'neq': 'not_equals',
  '>': 'greater_than',
  'gt': 'greater_than',
  'after': 'greater_than',
  '>=': 'greater_than_or_equal',
  'gte': 'greater_than_or_equal',
  'on_or_after': 'greater_than_or_equal',
  '<': 'less_than',
  'lt': 'less_than',
  'before': 'less_than',
  '<=': 'less_than_or_equal',
  'lte': 'less_than_or_equal',
  'on_or_before': 'less_than_or_equal',
  'like': 'contains',
  'ilike': 'contains',
  'match': 'contains',
};

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
  return Object.prototype.hasOwnProperty.call(ENTITY_SCHEMAS, entity.trim().toLowerCase());
}

/**
 * Normalizes entity name (e.g. 'product' -> 'products', 'service' -> 'services').
 * @param {string} entity
 * @returns {string}
 */
function normalizeEntityName(entity) {
  if (typeof entity !== 'string') {
    throw new AppError('Entity name must be a string.', 400);
  }
  const clean = entity.trim().toLowerCase();
  if (clean === 'product' || clean === 'products') return 'products';
  if (clean === 'service' || clean === 'services') return 'services';
  if (ENTITY_SCHEMAS[clean]) return clean;
  throw new AppError(
    `Unknown entity "${entity}". Supported entities are: ${getSupportedEntities().join(', ')}.`,
    400
  );
}

/**
 * Returns the schema definition for a specified entity.
 * @param {string} entity
 * @returns {object}
 */
function getSchema(entity) {
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
    throw new AppError('Filter must be an object with "field", "operator", and "value".', 400);
  }

  const rawField = String(filter.field ?? '').trim().toLowerCase();
  if (!rawField || !schema.columns[rawField]) {
    throw new AppError(
      `Field "${filter.field}" does not exist on entity "${schema.entity}". Available fields: ${Object.keys(schema.columns).filter((c) => schema.columns[c].queryable).join(', ')}.`,
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

  // Type validation and coercion for value
  let normalizedValue = filter.value;

  if (colDef.type === 'number' || colDef.type === 'integer') {
    if (operator === 'between') {
      if (!Array.isArray(normalizedValue) || normalizedValue.length !== 2) {
        throw new AppError(`Operator "between" on "${rawField}" requires an array of two numbers [min, max].`, 400);
      }
      const num0 = Number(normalizedValue[0]);
      const num1 = Number(normalizedValue[1]);
      if (!Number.isFinite(num0) || !Number.isFinite(num1)) {
        throw new AppError(`Values in "between" filter for "${rawField}" must be valid numbers.`, 400);
      }
      normalizedValue = [num0, num1];
    } else {
      const num = Number(normalizedValue);
      if (!Number.isFinite(num)) {
        throw new AppError(`Field "${rawField}" expects a valid number, got "${filter.value}".`, 400);
      }
      normalizedValue = colDef.type === 'integer' ? Math.round(num) : num;
      if (colDef.min !== undefined && normalizedValue < colDef.min) {
        throw new AppError(`Field "${rawField}" must be >= ${colDef.min}.`, 400);
      }
    }
  } else if (colDef.type === 'date') {
    if (operator === 'relative_days_ago') {
      const days = Number(normalizedValue);
      if (!Number.isFinite(days) || days <= 0) {
        throw new AppError(`Operator "relative_days_ago" expects a positive number of days.`, 400);
      }
      normalizedValue = Math.round(days);
    } else if (operator === 'this_month') {
      normalizedValue = true;
    } else if (operator === 'between') {
      if (!Array.isArray(normalizedValue) || normalizedValue.length !== 2) {
        throw new AppError(`Operator "between" on "${rawField}" requires an array of two dates [start, end].`, 400);
      }
      normalizedValue = [String(normalizedValue[0]).trim(), String(normalizedValue[1]).trim()];
    } else {
      const strVal = String(normalizedValue ?? '').trim();
      if (!strVal) {
        throw new AppError(`Date filter on "${rawField}" requires a non-empty date value.`, 400);
      }
      normalizedValue = strVal;
    }
  } else if (colDef.type === 'string') {
    if (colDef.allowedValues) {
      const cleanVal = String(normalizedValue ?? '').trim().toLowerCase();
      // Support friendly synonyms
      let mappedVal = cleanVal;
      if (rawField === 'availability') {
        if (cleanVal === 'true' || cleanVal === 'in_stock' || cleanVal === 'yes') mappedVal = 'available';
        if (cleanVal === 'false' || cleanVal === 'out_of_stock' || cleanVal === 'no') mappedVal = 'unavailable';
      }
      if (!colDef.allowedValues.includes(mappedVal)) {
        throw new AppError(
          `Invalid value "${normalizedValue}" for "${rawField}". Allowed values: ${colDef.allowedValues.join(', ')}.`,
          400
        );
      }
      normalizedValue = mappedVal;
    } else if (operator === 'in') {
      if (!Array.isArray(normalizedValue)) {
        throw new AppError(`Operator "in" on "${rawField}" requires an array of values.`, 400);
      }
      normalizedValue = normalizedValue.map((v) => String(v).trim());
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
    throw new AppError('Sort criteria must be an array of objects ({ field, direction }).', 400);
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
      throw new AppError(`Field "${rawField}" is not sortable on ${schema.entity}.`, 400);
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
    throw new AppError(`Unsupported mutation operation "${mutation.operation}". Supported operations are: update, delete, create.`, 400);
  }

  // Target filters are required for update and delete to prevent accidental whole-table operations
  const targetFilters = [];
  if (operation === 'update' || operation === 'delete') {
    const rawFilters = mutation.target_filters || mutation.filters || [];
    if (!Array.isArray(rawFilters) || rawFilters.length === 0) {
      throw new AppError(
        `Mutation "${operation}" requires at least one target filter (e.g. name or id) to identify records safely.`,
        400
      );
    }
    for (const f of rawFilters) {
      targetFilters.push(validateFilter(entity, f));
    }
  }

  // Changes validation for update and create
  const validatedChanges = {};
  if (operation === 'update' || operation === 'create') {
    const rawChanges = mutation.changes || {};
    if (typeof rawChanges !== 'object' || Object.keys(rawChanges).length === 0) {
      throw new AppError(`Mutation "${operation}" requires a non-empty "changes" object.`, 400);
    }

    for (const [key, val] of Object.entries(rawChanges)) {
      const fieldName = key.trim().toLowerCase();
      const colDef = schema.columns[fieldName];
      if (!colDef) {
        throw new AppError(`Cannot modify unknown field "${key}" on ${schema.entity}.`, 400);
      }
      if (!colDef.modifiable) {
        throw new AppError(`Field "${fieldName}" is read-only and cannot be modified.`, 400);
      }

      let coerced = val;
      if (colDef.type === 'number' || colDef.type === 'integer') {
        const num = Number(val);
        if (!Number.isFinite(num)) {
          throw new AppError(`Value for "${fieldName}" must be a valid number.`, 400);
        }
        coerced = colDef.type === 'integer' ? Math.round(num) : num;
        if (colDef.min !== undefined && coerced < colDef.min) {
          throw new AppError(`Value for "${fieldName}" must be >= ${colDef.min}.`, 400);
        }
      } else if (colDef.type === 'string') {
        if (colDef.allowedValues) {
          let cleanVal = String(val ?? '').trim().toLowerCase();
          if (cleanVal === 'true' || cleanVal === 'in_stock') cleanVal = 'available';
          if (cleanVal === 'false' || cleanVal === 'out_of_stock') cleanVal = 'unavailable';
          if (!colDef.allowedValues.includes(cleanVal)) {
            throw new AppError(`Invalid value "${val}" for "${fieldName}". Allowed values: ${colDef.allowedValues.join(', ')}.`, 400);
          }
          coerced = cleanVal;
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
