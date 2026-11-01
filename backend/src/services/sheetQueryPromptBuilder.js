const {
  getSchema,
  discoverTableSchema,
  validateFilter,
  validateSort,
  validateMutation,
} = require('./sheetSchemaService');
const { generateAiSheetInterpretation } = require('./geminiService');
const { loadCatalogPromptContext } = require('./catalogNameResolver');
const AppError = require('../utils/AppError');

const MAX_PROMPT_CATALOG_NAMES = 12;
const MAX_PROMPT_CATEGORIES = 8;

/**
 * Formats live catalog context (names + distinct categories/brands) for prompt grounding.
 *
 * @param {{ names?: string[], categories?: string[] } | null} catalog
 * @returns {string}
 */
function formatCatalogContext(catalog) {
  const names = Array.isArray(catalog?.names) ? catalog.names : [];
  const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];

  if (names.length === 0 && categories.length === 0) {
    return 'LIVE CATALOG CONTEXT\n(No catalog entries found for this request. Copy names and filters exactly as user wrote them.)';
  }

  const shownNames = names.slice(0, MAX_PROMPT_CATALOG_NAMES);
  const shownCategories = categories.slice(0, MAX_PROMPT_CATEGORIES);
  const lines = ['LIVE CATALOG CONTEXT (loaded from the database for this business)'];
  if (shownCategories.length > 0) {
    lines.push(`Known category/brand values: ${shownCategories.map((c) => JSON.stringify(c)).join(', ')}`);
  }
  if (shownNames.length > 0) {
    lines.push(`Representative item/product names (up to ${MAX_PROMPT_CATALOG_NAMES} shown):`);
    for (const n of shownNames) {
      lines.push(`- ${JSON.stringify(n)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Builds the natural-language prompt instructing Gemini to convert a spreadsheet query/mutation
 * into structured JSON according to the active table's dynamically discovered schema.
 *
 * @param {object} params
 * @param {string | object} [params.entity='products'] - Entity name or schema object
 * @param {object} [params.schema] - Optional resolved schema definition
 * @param {string} params.message - Raw user natural language prompt
 * @param {boolean} [params.isMutation=false] - Whether a mutation is expected
 * @param {string} [params.currentDate] - Current reference date in YYYY-MM-DD
 * @param {{ names?: string[], categories?: string[] } | null} [params.catalog] - Live catalog context
 * @returns {string}
 */
function buildSheetQueryPrompt({
  entity = 'products',
  schema: explicitSchema = null,
  message,
  isMutation = false,
  currentDate = new Date().toISOString().slice(0, 10),
  catalog = null,
}) {
  const schema = explicitSchema || getSchema(entity);

  const columnsList = Object.entries(schema.columns)
    .map(([, def]) => {
      const colName = def.exactName || def;
      const modifiable = def.modifiable && !def.virtual;
      let desc = `- ${colName} (${def.type}) [${modifiable ? 'modifiable' : 'read-only'}]`;
      if (def.storageType) {
        desc += ` [PostgreSQL: ${def.storageType}]`;
      }
      if (def.description) {
        desc += `: ${def.description}`;
      }
      if (def.nestedMap) {
        const structure = def.nestedStructure
          ? Object.entries(def.nestedStructure)
              .map(([key, type]) => `${key}:${type}`)
              .join(', ')
          : 'object with record-specific keys';
        desc += ` [nested map; representative keys/types: ${structure}]`;
      }
      if (def.allowedValues) {
        desc += ` [allowed values: ${def.allowedValues.map((v) => `"${v}"`).join(', ')}]`;
      }
      return desc;
    })
    .join('\n');

  // Format representative values block if available
  const repLines = [];
  if (schema.representativeValues && Object.keys(schema.representativeValues).length > 0) {
    for (const [col, vals] of Object.entries(schema.representativeValues)) {
      if (Array.isArray(vals) && vals.length > 0) {
        repLines.push(
          `- ${col}: ${vals.map((value) => JSON.stringify(value)).join(', ')}`
        );
      }
    }
  }
  const representativeValuesBlock =
    repLines.length > 0
      ? `Representative values:\n${repLines.join('\n')}`
      : '';

  const nestedMapColumns = Object.values(schema.columns)
    .filter((def) => def.nestedMap && def.modifiable)
    .map((def) => def.exactName);
  const nestedMapInstructions = nestedMapColumns.length
    ? `\nNested map columns: ${nestedMapColumns.join(', ')}. A dotted field targets one explicit key. For an operation over every key already in each matching row, use action "add_to_existing_values", "subtract_existing_values", "multiply_existing_values", or "set_existing_values" with key_policy "existing_keys_only". Iterate each row's own keys; never infer/union keys from other records or samples.`
    : '';

  return `Interpret the user's request as a safe spreadsheet query or mutation plan.

ACTIVE TABLE SCHEMA
Table: ${schema.tableName} (${schema.entity})

COMPLETE SCHEMA (exact database identifiers; logical type, storage type, mutability, metadata)
${columnsList}
${representativeValuesBlock ? `\n${representativeValuesBlock}\n` : ''}
${nestedMapInstructions}

INTERPRETATION RULES
- Map business concepts to physical fields using exact names, descriptions, types, nested structure, and representative values. Treat examples/values as evidence, not as a requirement that every row has them. Never invent a field.
- Infer roles from wording, field tokens, descriptions, types, and value patterns (item identity, maker, supplier, sales price, acquisition cost, on-hand quantity, reorder threshold, location, category, expiry, or status); do not map by name alone.
- Distinguish the requested business measure (for example, sale price versus acquisition cost). If no field fits, or multiple fields fit without a clear choice, return status "clarification_needed" and explain.
- Preserve every stated condition and update. Use target_filters for mutation criteria; filter_logic is AND unless the user clearly says OR. Use match_all only when the user explicitly targets every row.
- Use exact schema column names. A product/item reference filters on the best matching name-like field; copy the requested value exactly.
- Mutations use operation update/update_many, create, or delete. Set uses action "set"; arithmetic uses "add", "subtract", or "multiply". Use unit "absolute" for amounts, "percentage" for relative percentage changes, and "percentage_points" for changes to a percentage-valued field.
- A discount is a percentage-valued field when present. Do not treat a cost field as a sale-price field. A pricing request without a confidently matching field needs clarification.
- For a query use operation "filter", filters, optional sort and limit. For a mutation use updates with field/action/value/unit. Every update must name a real modifiable schema field.
- For nested maps, a dotted field changes one named key. Include key_policy "existing_keys_only" unless the user explicitly asks to create a missing key, in which case use "create_if_missing". Operations over all existing entries must use the existing-keys-only representation above, and must not include a generated or shared list of keys.
- Return JSON only. If the operation, target field, condition, amount, unit, or scope cannot be determined, return {"status":"clarification_needed","message":"..."}.

OUTPUT
Use the existing JSON contract:
{"status":"ok","entity":"${schema.entity}","operation":"filter|update|update_many|create|delete","filter_logic":"AND|OR","match_all":false,"filters":[],"target_filters":[],"updates":[],"sort":[],"limit":null}
Use only fields relevant to the operation. Query filters and mutation target_filters use {field,operator,value}. Updates use {field,action,value,unit}; existing-map operations also use {key_policy:"existing_keys_only"}.

Reference date: ${currentDate}
Request mode: ${isMutation ? 'mutation' : 'query'}

${formatCatalogContext(catalog)}

USER MESSAGE:
<user_message>
${message}
</user_message>
`;
}

/**
 * Determines whether a validation error represents a hard value/domain constraint violation
 * (which should be rejected with HTTP 400) versus an incomplete/ambiguous request or
 * schema column limitation (which should return status: 'clarification_needed').
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isHardConstraintValidationError(err) {
  const msg = String(err?.message || '');
  return (
    msg.includes('must be <=') ||
    msg.includes('must be >=') ||
    msg.includes('non-negative integer') ||
    msg.includes('cannot be negative') ||
    msg.includes('cannot exceed') ||
    msg.includes('Cannot subtract more than 100%') ||
    msg.includes('Cannot reduce stock') ||
    msg.includes('Arithmetic action') ||
    msg.includes('requires an integer') ||
    msg.includes('must be a whole integer') ||
    msg.includes('Unsupported apparel size key') ||
    msg.includes('Invalid size key')
  );
}

/**
 * Validates and normalizes the parsed JSON interpretation returned by the LLM.
 *
 * @param {string | object} entityOrSchema
 * @param {object} parsed
 * @returns {object}
 */
function normalizeInterpretedQuery(entityOrSchema, parsed) {
  const schema = getSchema(entityOrSchema);
  const normalizedEntity = schema.entity;

  if (!parsed || typeof parsed !== 'object') {
    return {
      status: 'clarification_needed',
      message: 'Could not interpret request into a structured spreadsheet query.',
      entity: normalizedEntity,
      operation: null,
      filters: [],
      sort: [],
      limit: null,
    };
  }

  if (parsed.status === 'clarification_needed') {
    return {
      status: 'clarification_needed',
      message: String(parsed.message || 'Please provide more details for this query.').trim(),
      entity: normalizedEntity,
      operation: null,
      filters: [],
      sort: [],
      limit: null,
    };
  }

  const operation = String(parsed.operation || 'filter').trim().toLowerCase();

  // If mutation operation (update, update_many, delete, create)
  if (
    operation === 'update' ||
    operation === 'update_many' ||
    operation === 'delete' ||
    operation === 'create'
  ) {
    try {
      const validatedMut = validateMutation(schema, {
        operation,
        filter_logic: parsed.filter_logic || parsed.logical_operator || 'AND',
        match_all: Boolean(parsed.match_all),
        target_filters: parsed.target_filters || parsed.filters || [],
        updates: parsed.updates,
        changes: parsed.changes || {},
      });
      return {
        status: 'ok',
        message: String(parsed.message || '').trim(),
        entity: normalizedEntity,
        operation: validatedMut.operation,
        filter_logic: validatedMut.filter_logic,
        match_all: validatedMut.match_all,
        target_filters: validatedMut.target_filters,
        updates: validatedMut.updates,
        changes: validatedMut.changes,
      };
    } catch (err) {
      if (isHardConstraintValidationError(err)) {
        throw err;
      }
      return {
        status: 'clarification_needed',
        message: err.message,
        entity: normalizedEntity,
        operation: null,
        filters: [],
        sort: [],
        limit: null,
      };
    }
  }

  // Filter / read operation
  const rawFilters = Array.isArray(parsed.filters)
    ? parsed.filters
    : Array.isArray(parsed.target_filters)
      ? parsed.target_filters
      : [];
  const validatedFilters = [];

  for (const f of rawFilters) {
    try {
      validatedFilters.push(validateFilter(schema, f));
    } catch (err) {
      return {
        status: 'clarification_needed',
        message: `Schema limitation: ${err.message}`,
        entity: normalizedEntity,
        operation: null,
        filters: [],
        sort: [],
        limit: null,
      };
    }
  }

  let validatedSort = [];
  try {
    validatedSort = validateSort(schema, parsed.sort || []);
  } catch {
    validatedSort = [];
  }

  let limit = null;
  if (parsed.limit !== null && parsed.limit !== undefined) {
    const parsedLimit = Number.parseInt(parsed.limit, 10);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      limit = Math.min(parsedLimit, 500);
    }
  }

  const rawFilterLogic = String(
    parsed.filter_logic || parsed.logical_operator || 'AND'
  )
    .trim()
    .toUpperCase();
  const filterLogic = rawFilterLogic === 'OR' ? 'OR' : 'AND';

  return {
    status: 'ok',
    message: String(parsed.message || '').trim(),
    entity: normalizedEntity,
    operation: 'filter',
    filter_logic: filterLogic,
    filters: validatedFilters,
    sort: validatedSort,
    limit,
  };
}

/**
 * High-level service function:
 * Dynamically discovers the active table schema, resolves catalog context if applicable,
 * prompts the LLM, and validates the interpreted result against the active schema.
 *
 * @param {object} params
 * @param {string | object} [params.entity='products'] - Active table / entity name
 * @param {string} params.message - user natural language prompt
 * @param {boolean} [params.isMutation=false]
 * @param {string} [params.currentDate]
 * @param {string} [params.businessId]
 * @returns {Promise<object>}
 */
async function interpretNaturalLanguageQuery({
  entity = 'products',
  message,
  isMutation = false,
  currentDate,
  businessId,
  schema: suppliedSchema = null,
}) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new AppError('Message is required and must be a non-empty string.', 400);
  }

  // 1. Dynamically discover the schema of the active table
  const schema = suppliedSchema || (await discoverTableSchema(entity, businessId));

  // 2. Load catalog names if businessId is present and table has a name column
  let catalog = null;
  if (businessId) {
    try {
      catalog = await loadCatalogPromptContext(businessId, schema);
    } catch {
      // Catalog grounding is best-effort
    }
  }

  // 3. Build the prompt with the active schema injected
  const promptText = buildSheetQueryPrompt({
    schema,
    entity: schema.entity,
    message: message.trim(),
    isMutation,
    currentDate,
    catalog,
  });

  // 4. Send to Gemini for interpretation
  const rawAiResult = await generateAiSheetInterpretation(promptText);

  // 5. Normalize and validate against the active table schema
  return normalizeInterpretedQuery(schema, rawAiResult);
}

module.exports = {
  buildSheetQueryPrompt,
  formatCatalogContext,
  normalizeInterpretedQuery,
  interpretNaturalLanguageQuery,
};
