const SYSTEM_COLUMNS = new Set([
  'id',
  'business_id',
  'workspace_id',
  'user_id',
  'created_at',
  'updated_at',
  '_google_row_index',
  'workspace_document_id',
]);

const LONG_PROSE_COLUMN_NAMES = new Set([
  'description',
  'notes',
  'comments',
  'summary',
  'full_text',
  'raw_text',
  'body',
  'images',
  'image_url',
  'product_url',
  'url',
]);

const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS_LIKE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const MAX_ENUM_COUNT = 15;
const MAX_VALUE_CHARS = 50;

function truncateValue(val, maxChars = MAX_VALUE_CHARS) {
  const s = String(val ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.length > maxChars ? `${s.slice(0, maxChars - 3)}...` : s;
}

/**
 * Produces a compact, high-signal table descriptor for LLM routing and planning prompts.
 * Strips system columns, long prose/descriptions, raw JSON blobs, UUIDs, and timestamps
 * while preserving true low-cardinality enum values (<= 15 concise values), numeric ranges,
 * nested map keys, primary key, email column, and table summary.
 *
 * @param {object} tableEntry
 * @param {object} [options]
 * @param {boolean} [options.includeMutability=true]
 * @returns {object}
 */
function serializeTableForPrompt(tableEntry, { includeMutability = true } = {}) {
  const {
    tableName,
    displayName,
    rowCount,
    schema = {},
    metadata = {},
  } = tableEntry || {};
  const primaryKey =
    metadata?.primary_key_column || schema?.primaryKey || undefined;
  const emailCol = metadata?.email_column || undefined;
  const tableSummary = metadata?.table_summary
    ? String(metadata.table_summary).slice(0, 200)
    : undefined;

  const profileByCol = new Map();
  for (const colProfile of metadata?.columns_profile || []) {
    if (colProfile?.column_name) {
      profileByCol.set(String(colProfile.column_name).toLowerCase(), colProfile);
    }
  }

  const columns = [];
  for (const column of Object.values(schema.columns || {})) {
    const exactName = String(column.exactName || '').trim();
    if (!exactName) continue;
    const lower = exactName.toLowerCase();
    const isPk = primaryKey && lower === String(primaryKey).toLowerCase();
    if (SYSTEM_COLUMNS.has(lower) && !isPk) continue;

    const prof = profileByCol.get(lower);
    const role = prof?.semantic_role || undefined;
    const effectiveType = prof?.data_type || column.type || 'string';
    const isEmail =
      role === 'email' ||
      (emailCol && lower === String(emailCol).toLowerCase());
    const isLongProseCol = LONG_PROSE_COLUMN_NAMES.has(lower);
    const isJsonCol =
      column.type === 'json' ||
      effectiveType === 'jsonb' ||
      Boolean(prof?.nested_structure);
    const isDateCol = effectiveType === 'date' || column.type === 'date';
    const isNumericCol =
      ['numeric', 'number', 'integer'].includes(effectiveType) ||
      ['number', 'integer'].includes(column.type);

    const rawValues =
      Array.isArray(prof?.categorical_values) && prof.categorical_values.length > 0
        ? prof.categorical_values
        : Array.isArray(schema.representativeValues?.[exactName])
          ? schema.representativeValues[exactName]
          : [];

    let enumValues;
    let idExamples;
    let dateRange;
    if (!isEmail && !isLongProseCol && !isJsonCol && rawValues.length > 0) {
      const cleaned = rawValues
        .map((v) => String(v ?? '').replace(/\s+/g, ' ').trim())
        .filter(
          (s) =>
            s.length > 0 &&
            !UUID_LIKE_RE.test(s) &&
            !ISO_TS_LIKE_RE.test(s) &&
            !/^\s*[{[]/.test(s)
        );
      if (role === 'identifier' || isPk) {
        if (cleaned.length > 0) {
          idExamples = cleaned
            .slice(0, 2)
            .map((s) => truncateValue(s, MAX_VALUE_CHARS));
        }
      } else if (isDateCol) {
        if (cleaned.length > 0) {
          const sortedDates = [...cleaned].sort();
          dateRange = [
            truncateValue(sortedDates[0], MAX_VALUE_CHARS),
            truncateValue(sortedDates[sortedDates.length - 1], MAX_VALUE_CHARS),
          ];
        }
      } else if (
        !isNumericCol &&
        cleaned.length > 0 &&
        cleaned.length <= MAX_ENUM_COUNT &&
        cleaned.every((s) => s.length <= 80)
      ) {
        enumValues = cleaned.map((s) => truncateValue(s, MAX_VALUE_CHARS));
      }
    }

    const colObj = {
      name: exactName,
      type: column.type,
    };
    if (includeMutability) {
      colObj.mutable = Boolean(column.modifiable && !column.virtual);
    } else {
      colObj.queryable = Boolean(column.queryable !== false);
    }
    if (role) colObj.role = role;
    if (enumValues && enumValues.length > 0) colObj.values = enumValues;
    if (idExamples && idExamples.length > 0) colObj.examples = idExamples;
    if (
      prof?.numeric_stats &&
      (prof.numeric_stats.min !== null || prof.numeric_stats.max !== null)
    ) {
      colObj.range = [prof.numeric_stats.min, prof.numeric_stats.max];
    } else if (dateRange) {
      colObj.range = dateRange;
    }
    if (prof?.nested_structure?.observed_keys?.length) {
      colObj.nested_keys = prof.nested_structure.observed_keys
        .slice(0, 8)
        .map((k) => k.name);
    }
    columns.push(colObj);
  }

  return {
    table: tableName,
    display_name:
      displayName && displayName !== tableName ? displayName : undefined,
    summary: tableSummary,
    row_count: typeof rowCount === 'number' ? rowCount : undefined,
    primary_key: primaryKey,
    email_column: emailCol,
    columns,
  };
}

module.exports = {
  SYSTEM_COLUMNS,
  LONG_PROSE_COLUMN_NAMES,
  MAX_ENUM_COUNT,
  MAX_VALUE_CHARS,
  truncateValue,
  serializeTableForPrompt,
};
