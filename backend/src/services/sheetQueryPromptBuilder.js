const {
  APPAREL_SIZE_KEYS,
  getSchema,
  normalizeEntityName,
  validateFilter,
  validateSort,
  validateMutation,
} = require('./sheetSchemaService');
const { generateAiSheetInterpretation } = require('./geminiService');
const { loadCatalogNames } = require('./productNameResolver');
const AppError = require('../utils/AppError');

const MAX_PROMPT_CATALOG_NAMES = 300;
const MAX_PROMPT_CATEGORIES = 100;

/**
 * Formats the business's live catalog (product names + distinct categories) for prompt grounding.
 * Values are read from the database at request time; nothing is hardcoded.
 *
 * @param {{ names?: string[], categories?: string[] } | null} catalog
 * @returns {string}
 */
function formatCatalogContext(catalog) {
  const names = Array.isArray(catalog?.names) ? catalog.names : [];
  const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];

  if (names.length === 0 && categories.length === 0) {
    return 'LIVE CATALOG CONTEXT\n(Catalog names are not available for this request. Copy product names exactly as the user wrote them.)';
  }

  const shownNames = names.slice(0, MAX_PROMPT_CATALOG_NAMES);
  const shownCategories = categories.slice(0, MAX_PROMPT_CATEGORIES);
  const lines = ['LIVE CATALOG CONTEXT (loaded from the database for this business; use only for spelling/grounding)'];
  if (shownCategories.length > 0) {
    lines.push(`Distinct "category" values: ${shownCategories.map((c) => JSON.stringify(c)).join(', ')}`);
  }
  if (shownNames.length > 0) {
    lines.push(`Product names (${names.length} total${names.length > shownNames.length ? `, first ${shownNames.length} shown` : ''}):`);
    for (const n of shownNames) {
      lines.push(`- ${JSON.stringify(n)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Builds the natural-language prompt instructing Gemini to convert a spreadsheet query/mutation
 * into structured JSON according to the products schema. The prompt is grounded in the business's
 * live catalog (names and categories are injected at request time) and contains no hardcoded
 * product data, so it works for arbitrary product names.
 *
 * @param {object} params
 * @param {string} [params.entity='products'] - Must resolve to 'products'
 * @param {string} params.message - Raw user natural language prompt
 * @param {boolean} [params.isMutation=false] - Whether a mutation is expected
 * @param {string} [params.currentDate] - Current reference date in YYYY-MM-DD
 * @param {{ names?: string[], categories?: string[] } | null} [params.catalog] - Live catalog context
 * @returns {string}
 */
function buildSheetQueryPrompt({
  entity = 'products',
  message,
  isMutation = false,
  currentDate = new Date().toISOString().slice(0, 10),
  catalog = null,
}) {
  const schema = getSchema(entity);
  const sizeKeys = Array.from(APPAREL_SIZE_KEYS);
  const columnsList = Object.entries(schema.columns)
    .filter(([, def]) => !def.readonly || def.virtual)
    .map(([col, def]) => {
      let desc = `- "${col}" (${def.type})`;
      if (def.description) {
        desc += `: ${def.description}`;
      }
      if (def.allowedValues) {
        desc += ` [allowed values: ${def.allowedValues.map((v) => `"${v}"`).join(', ')}]`;
      }
      if (def.operators) {
        desc += ` [operators: ${def.operators.join(', ')}]`;
      }
      return desc;
    })
    .join('\n');

  return `ROLE
You are a precise spreadsheet query and mutation interpreter for a product catalog management system.

OBJECTIVE
Translate the user's natural language request into a strictly structured JSON query or mutation plan for the "${schema.entity}" table.
${isMutation ? 'Note: The user is invoking the mutation endpoint, so interpret actionable change requests as "update_many", "update", "create", or "delete" operations.' : ''}

CURRENT REFERENCE DATE
Today's date is: ${currentDate}

ENTITY SCHEMA: "${schema.entity}" (Table: ${schema.tableName})
Available fields:
${columnsList}
- "size.<SIZE_KEY>" (integer): Nested stock count for one size key inside the JSON "size" column. Valid size keys: ${sizeKeys.join(', ')} (e.g., "size.${sizeKeys[0]}"). Supports numeric filter operators and update actions [set, add, subtract, multiply].
- "total_stock" (integer, virtual, filter-only): Sum of stock units across all sizes in "size".

FIELD CONVENTIONS
- "name": Free-text product title. Names are arbitrary user data and may contain any words, punctuation, or trailing periods.
- "category": Free-text category. Use the distinct values from LIVE CATALOG CONTEXT when the user refers to a category (map plural/colloquial wording such as "all <category>s" to the closest listed value with operator "equals").
- "best": Boolean best-seller / "best value" flag.
- "color": Comma-separated colors. Filter a specific color with {"field": "color", "operator": "contains", "value": "<Color>"}.
- "discount": Percentage discount stored as a number from 0 to 100 (25 means 25%).
- "ordered": Integer count of orders placed.
- "size": JSON string mapping size labels to stock counts, e.g. '{"${sizeKeys[0]}":2,"${sizeKeys[1]}":4}'. "available in size <KEY>" -> {"field": "size", "operator": "contains", "value": "<KEY>"}.
- "price": Numeric price.

${formatCatalogContext(catalog)}

PRODUCT NAME RULES (CRITICAL)
1. You are NOT the authority on whether a product exists. The backend resolves product names against the database (case-, punctuation- and spacing-insensitive, partial-name aware).
2. NEVER return "clarification_needed" because a product name seems unknown, misspelled, or absent from LIVE CATALOG CONTEXT. NEVER answer "not found" or "did you mean".
3. When the user refers to a specific product by name, emit {"field": "name", "operator": "equals", "value": "<name>"}. If a catalog name in LIVE CATALOG CONTEXT clearly refers to the same product (differs only by case, punctuation, a trailing period, or spacing), copy that catalog name exactly; otherwise copy the user's wording verbatim.
4. Never substitute a different product that merely shares some words with what the user wrote.
5. Multiple named products ("A and B") -> one {"field": "name", "operator": "equals"} filter per product with "filter_logic": "OR".

FILTERING & LOGIC RULES
- Allowed operators: "equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "in", "greater_than", "less_than", "greater_than_or_equal", "less_than_or_equal", "between", "relative_days_ago", "this_month".
- Combine multiple filters with "filter_logic": "AND" by default. Use "OR" ONLY when the user explicitly asks for alternatives ("X or Y") or names several distinct products.
- If a bulk mutation explicitly targets ALL products with no condition, set "target_filters": [] and "match_all": true.
- Conditions such as "if it isn't already set" may be expressed as an extra filter on the field being changed (e.g., {"field": "best", "operator": "equals", "value": false}).

MUTATION CONTRACT ("update_many" / "update" / "delete" / "create")
- "operation": "update_many" (conditional/bulk/arithmetic updates) or "update" (a single named product)
- "filter_logic": "AND" | "OR"
- "match_all": boolean (true only when targeting every product with no filters)
- "target_filters": [{"field": "...", "operator": "...", "value": ...}]
- "updates": [{"field": "<column or size.<KEY>>", "action": "set" | "add" | "subtract" | "multiply", "value": <number | boolean | string>, "unit": "absolute" | "percentage" | "percentage_points"}]
- When the same change applies to several sizes ("sizes XL and M"), emit ONE update entry PER size key (e.g., "size.XL" and "size.M").

ARITHMETIC & PERCENTAGE SEMANTICS (CRITICAL)
1. "Set/Change/Update X to Y", or "Increase/Reduce X ... to Y" -> {"action": "set", "value": Y}. The preposition "to" means the final value.
2. "Increase/Add/Raise X by Y" -> "add"; "Reduce/Decrease/Lower X by Y" -> "subtract".
   - "discount" changed by N% -> {"field": "discount", "action": "add" | "subtract", "value": N, "unit": "percentage_points"} (e.g., 25 -> 30).
   - "price" changed by N% -> {"field": "price", "action": "add" | "subtract", "value": N, "unit": "percentage"} (multiplies by 1 ± N/100).
   - "price" changed by a plain amount -> "unit": "absolute".
   - Size stock changed by N units -> {"field": "size.<KEY>", "action": "add" | "subtract", "value": N, "unit": "absolute"}.
3. "Multiply/Double/Triple X" -> {"action": "multiply", "value": factor}.

AMBIGUITY & VALIDATION RULES
- Return "status": "clarification_needed" ONLY when the request is missing the change amount/value or direction, missing which sizes to change for a stock change, has no identifiable target scope, or references a column that does not exist in the schema (e.g., "warehouse", "supplier", "weight").
- If the user gives an explicit value on a valid column — even an out-of-range one (discount > 100, negative stock or price) — still output the structured mutation with "status": "ok"; the backend validator rejects invalid values deterministically.

OUTPUT FORMAT (Return valid JSON only; the angle-bracket values below are placeholders, not real data)
Example A (named product, multiple sizes):
User: "Increase stock of <Product Name> for sizes ${sizeKeys[2]} and ${sizeKeys[0]} by 2"
{
  "status": "ok",
  "message": "Increase ${sizeKeys[2]} and ${sizeKeys[0]} stock of <Product Name> by 2",
  "entity": "products",
  "operation": "update",
  "filter_logic": "AND",
  "match_all": false,
  "target_filters": [{"field": "name", "operator": "equals", "value": "<Product Name>"}],
  "updates": [
    {"field": "size.${sizeKeys[2]}", "action": "add", "value": 2, "unit": "absolute"},
    {"field": "size.${sizeKeys[0]}", "action": "add", "value": 2, "unit": "absolute"}
  ]
}

Example B (conditional bulk arithmetic):
User: "Reduce the price of products with a discount of 25% or more by 200"
{
  "status": "ok",
  "message": "Reduce price by 200 for products with discount >= 25",
  "entity": "products",
  "operation": "update_many",
  "filter_logic": "AND",
  "match_all": false,
  "target_filters": [{"field": "discount", "operator": "greater_than_or_equal", "value": 25}],
  "updates": [{"field": "price", "action": "subtract", "value": 200, "unit": "absolute"}]
}

Example C (all products):
User: "Increase the stock of size ${sizeKeys[0]} by 5 units for all products"
{
  "status": "ok",
  "message": "Increase size ${sizeKeys[0]} stock by 5 for all products",
  "entity": "products",
  "operation": "update_many",
  "filter_logic": "AND",
  "match_all": true,
  "target_filters": [],
  "updates": [{"field": "size.${sizeKeys[0]}", "action": "add", "value": 5, "unit": "absolute"}]
}

Example D (read query):
{
  "status": "ok",
  "message": "",
  "entity": "products",
  "operation": "filter",
  "filter_logic": "AND",
  "filters": [{"field": "best", "operator": "equals", "value": true}],
  "sort": [],
  "limit": null
}

Example E (clarification — missing value):
User: "Update the discount of <Product Name>"
{
  "status": "clarification_needed",
  "message": "What new discount percentage would you like to set for <Product Name>?",
  "entity": "products",
  "operation": null,
  "filters": [],
  "sort": [],
  "limit": null
}

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
 * @param {string} [entity='products']
 * @param {object} parsed
 * @returns {object}
 */
function normalizeInterpretedQuery(entity = 'products', parsed) {
  const normalizedEntity = normalizeEntityName(entity || 'products');

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
      const validatedMut = validateMutation(normalizedEntity, {
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
      validatedFilters.push(validateFilter(normalizedEntity, f));
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
    validatedSort = validateSort(normalizedEntity, parsed.sort || []);
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
 * Converts natural-language request into a validated query or clarification response.
 *
 * @param {object} params
 * @param {string} [params.entity='products'] - Must resolve to 'products'
 * @param {string} params.message - user natural language prompt
 * @param {boolean} [params.isMutation=false]
 * @param {string} [params.currentDate]
 * @param {string} [params.businessId] - When provided, the business's live product names and
 *   categories are loaded and injected into the prompt for grounding.
 * @returns {Promise<object>}
 */
async function interpretNaturalLanguageQuery({
  entity = 'products',
  message,
  isMutation = false,
  currentDate,
  businessId,
}) {
  const normalizedEntity = normalizeEntityName(entity || 'products');

  if (typeof message !== 'string' || !message.trim()) {
    throw new AppError('Message is required and must be a non-empty string.', 400);
  }

  let catalog = null;
  if (businessId) {
    try {
      const rows = await loadCatalogNames(businessId, normalizedEntity);
      const names = [...new Set(rows.map((r) => r.name).filter(Boolean))];
      const categories = [
        ...new Set(rows.map((r) => (r.category ? String(r.category).trim() : '')).filter(Boolean)),
      ].sort();
      catalog = { names, categories };
    } catch (err) {
      // Catalog grounding is best-effort; the backend name resolver still guarantees matching.
      console.warn('Could not load catalog context for sheet prompt:', err.message);
    }
  }

  const promptText = buildSheetQueryPrompt({
    entity: normalizedEntity,
    message: message.trim(),
    isMutation,
    currentDate,
    catalog,
  });

  const rawAiResult = await generateAiSheetInterpretation(promptText);
  return normalizeInterpretedQuery(normalizedEntity, rawAiResult);
}

module.exports = {
  buildSheetQueryPrompt,
  formatCatalogContext,
  normalizeInterpretedQuery,
  interpretNaturalLanguageQuery,
};
