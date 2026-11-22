const AppError = require('./AppError');
const {
  parseCleanNumber,
  coerceBooleanValue,
} = require('../services/sheetSchemaService');

/**
 * Validates and coerces a raw input value into the native JS/SQL type
 * expected by a discovered PostgreSQL column definition.
 *
 * @param {object} colDef
 * @param {string} colName
 * @param {any} rawValue
 * @returns {any}
 */
function coerceValueForColumn(colDef, colName, rawValue) {
  const colType = colDef?.type || 'string';
  const isIntStorage =
    colType === 'integer' ||
    String(colDef?.storageType || '').toLowerCase().includes('int');

  if (isIntStorage) {
    const n = parseCleanNumber(rawValue);
    if (!Number.isFinite(n)) {
      throw new AppError(
        `Column "${colName}" requires a numeric/integer value, received "${rawValue}".`,
        400
      );
    }
    const rounded = Math.round(n);
    if (colDef.min !== undefined && rounded < colDef.min) {
      throw new AppError(
        `Column "${colName}" value ${rounded} is below minimum ${colDef.min}.`,
        400
      );
    }
    if (colDef.max !== undefined && rounded > colDef.max) {
      throw new AppError(
        `Column "${colName}" value ${rounded} exceeds maximum ${colDef.max}.`,
        400
      );
    }
    return rounded;
  }

  if (colType === 'number') {
    const n = parseCleanNumber(rawValue);
    if (!Number.isFinite(n)) {
      throw new AppError(
        `Column "${colName}" requires a numeric value, received "${rawValue}".`,
        400
      );
    }
    const rounded = Math.round(n * 100) / 100;
    if (colDef.min !== undefined && rounded < colDef.min) {
      throw new AppError(
        `Column "${colName}" value ${rounded} is below minimum ${colDef.min}.`,
        400
      );
    }
    if (colDef.max !== undefined && rounded > colDef.max) {
      throw new AppError(
        `Column "${colName}" value ${rounded} exceeds maximum ${colDef.max}.`,
        400
      );
    }
    return rounded;
  }

  if (colType === 'boolean') {
    const coerced = coerceBooleanValue(rawValue);
    if (typeof coerced !== 'boolean') {
      throw new AppError(
        `Column "${colName}" requires a boolean ("true" or "false"), received "${rawValue}".`,
        400
      );
    }
    return coerced;
  }

  if (colType === 'date') {
    const strVal = String(rawValue ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(strVal)) {
      const parsed = new Date(`${strVal}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === strVal) {
        return strVal;
      }
      throw new AppError(
        `Column "${colName}" requires a valid calendar date (YYYY-MM-DD), received "${rawValue}".`,
        400
      );
    }
    const parsed = new Date(strVal);
    if (!strVal || Number.isNaN(parsed.getTime())) {
      throw new AppError(
        `Column "${colName}" requires a valid date (YYYY-MM-DD), received "${rawValue}".`,
        400
      );
    }
    return parsed.toISOString().slice(0, 10);
  }

  if (colDef?.nestedMap || colType === 'json') {
    let parsedObj = rawValue;
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (!trimmed.startsWith('{')) {
        throw new AppError(
          `Column "${colName}" is a nested JSON map column and requires a valid JSON object string (e.g. "{\\"M\\":2,\\"L\\":3}"), received "${rawValue}".`,
          400
        );
      }
      try {
        parsedObj = JSON.parse(trimmed);
      } catch {
        throw new AppError(
          `Column "${colName}" contains invalid JSON: "${rawValue}".`,
          400
        );
      }
    }
    if (!parsedObj || typeof parsedObj !== 'object' || Array.isArray(parsedObj)) {
      throw new AppError(
        `Column "${colName}" must be a JSON object mapping keys to numeric quantities.`,
        400
      );
    }
    const normalizedObj = {};
    for (const [k, v] of Object.entries(parsedObj)) {
      if (!/^[a-z0-9_-]+$/i.test(k)) {
        throw new AppError(`Invalid nested map key "${k}" on column "${colName}".`, 400);
      }
      const num = parseCleanNumber(v);
      if (!Number.isFinite(num) || num < 0) {
        throw new AppError(
          `Nested map value for "${colName}.${k}" must be a non-negative number, received "${v}".`,
          400
        );
      }
      normalizedObj[k] =
        colDef.nestedValueType === 'integer'
          ? Math.round(num)
          : Math.round(num * 100) / 100;
    }
    return JSON.stringify(normalizedObj);
  }

  return String(rawValue ?? '').trim();
}

module.exports = {
  coerceValueForColumn,
};
