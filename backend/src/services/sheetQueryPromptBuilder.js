const {
  APPAREL_SIZE_KEYS,
  getSchema,
  discoverTableSchema,
  findColumnDef,
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
    lines.push(`Item/product names (${names.length} total${names.length > shownNames.length ? `, first ${shownNames.length} shown` : ''}):`);
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
    .filter(([, def]) => !def.readonly || def.virtual)
    .map(([, def]) => {
      const colName = def.exactName || def;
      let desc = `- ${colName} (${def.type})`;
      if (def.description) {
        desc += `: ${def.description}`;
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
        repLines.push(`- ${col}: ${vals.join(', ')}`);
      }
    }
  }
  const representativeValuesBlock =
    repLines.length > 0
      ? `Representative values:\n${repLines.join('\n')}`
      : '';

  // Check if active table has apparel size column
  const hasSizeColumn = Boolean(findColumnDef(schema, 'size'));
  const sizeInstructions = hasSizeColumn
    ? `\nSPECIAL NESTED SIZE FIELDS\n- "size.<SIZE_KEY>" (integer): Stock for one size key in JSON "size" column. Allowed size keys: ${Array.from(
        APPAREL_SIZE_KEYS
      ).join(', ')}. Supports numeric arithmetic.\n- "total_stock" (integer, virtual, filter-only): Sum of stock units across all sizes.\n`
    : '';

  return `ROLE
You are a precise spreadsheet query and mutation interpreter for a universal business inventory editor.

OBJECTIVE
Translate the user's natural language request into a strictly structured JSON query or mutation plan for the active table.
${isMutation ? 'Note: The user is invoking the mutation endpoint, so interpret actionable change requests as "update_many", "update", "create", or "delete" operations.' : ''}

CURRENT REFERENCE DATE
Today's date is: ${currentDate}

ACTIVE TABLE SCHEMA
Table: ${schema.tableName}

Available columns:
${columnsList}
${representativeValuesBlock ? `\n${representativeValuesBlock}\n` : ''}${sizeInstructions}
GENERAL INVENTORY DOMAIN & SEMANTIC COLUMN MAPPING
Understand the semantic purpose of columns dynamically regardless of how the user or table names them:
- Product title/name: e.g., "name", "Product_Name", "item_name", "title"
- Brand, manufacturer, or vendor: e.g., "brand", "Brand_Name", "manufacturer", "make"
- Supplier or distributor: e.g., "supplier", "Supplier", "vendor", "distributor", "source"
- Selling price vs. purchase cost (CRITICAL BUSINESS RULE):
  * Selling price: e.g., "price", "Selling_Price", "Current_Price", "retail_price"
  * Purchase/unit cost: e.g., "cost", "Unit_Cost", "purchase_price", "wholesale_price"
  * CRITICAL RULE: Never modify purchase/unit cost when the user asks to discount, put on sale, adjust price, or change pricing, unless the user explicitly mentions "cost" or "unit cost".
- Inventory quantity or stock: e.g., "stock", "Stock_Qty", "Quantity", "qty", "inventory_count", "units_available"
- Reorder threshold: e.g., "reorder_level", "Reorder_Level", "restock_point", "min_stock"
- Storage location: e.g., "warehouse", "Warehouse", "Warehouse_Location", "aisle", "bin", "location"
- Category, department, or section: e.g., "category", "Department", "type", "group"
- Expiration or shelf life: e.g., "expiry_date", "Expiry_Date", "expiration", "best_before", "use_by"
- SKU, barcode, or identifier: e.g., "sku", "item_code", "Batch_No", "barcode", "serial_number"
- Status flags: e.g., "best", "status", "Status", "is_clearance", "active"

DISCOUNT CONVENTIONS & ARITHMETIC RULES
1. "Put a 10% discount on all products from Asus":
   - If the active table has an explicit discount column (e.g., "discount"), update that column.
   - If the active table has a selling price column (e.g., "Current_Price" or "Selling_Price") but NO separate discount column, reduce the selling price by 10%:
     {"field": "<SellingPriceColumn>", "action": "subtract", "value": 10, "unit": "percentage"}
2. "Set/Change/Update/Mark X to/as Y" -> {"action": "set", "value": Y}
3. "Increase/Add/Raise X by Y" -> "add"; "Reduce/Decrease/Lower X by Y" -> "subtract"
   - Percentage adjustments: "unit": "percentage" (for prices/costs/quantities) or "percentage_points" (for discount columns)
   - Plain amounts: "unit": "absolute"
4. "Multiply/Double/Triple X" -> {"action": "multiply", "value": factor}

NAME MATCHING RULES
1. When user refers to a specific product/item, emit {"field": "<NameColumn>", "operator": "equals", "value": "<name>"}.
2. NEVER return "clarification_needed" merely because a product name seems unknown or absent from context; copy the user's name verbatim.

AMBIGUITY & CLARIFICATION RULES
- Return "status": "clarification_needed" when:
  * The requested target column cannot be resolved from the active schema (e.g. asking to change warranty on a grocery table that has no warranty column).
  * The request is missing the change value, direction, or target scope.
  * The request is fundamentally ambiguous.

OUTPUT FORMAT REQUIREMENTS
- Return valid JSON only.
- You MUST use the EXACT column names as listed under "Available columns" in the ACTIVE TABLE SCHEMA above.

JSON MUTATION CONTRACT ("update_many" / "update" / "delete" / "create"):
{
  "status": "ok",
  "message": "<brief description>",
  "entity": "${schema.entity}",
  "operation": "update_many",
  "filter_logic": "AND",
  "match_all": false,
  "target_filters": [
    {"field": "<ExactColumn>", "operator": "equals" | "greater_than" | "less_than" | ..., "value": ...}
  ],
  "updates": [
    {"field": "<ExactColumn>", "action": "set" | "add" | "subtract" | "multiply", "value": ..., "unit": "absolute" | "percentage" | "percentage_points"}
  ]
}

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
}) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new AppError('Message is required and must be a non-empty string.', 400);
  }

  // 1. Dynamically discover the schema of the active table
  const schema = await discoverTableSchema(entity, businessId);

  // 2. Load catalog names if businessId is present and table has a name column
  let catalog = null;
  if (businessId) {
    try {
      const rows = await loadCatalogNames(businessId, schema.entity);
      if (rows && rows.length > 0) {
        const names = [...new Set(rows.map((r) => r.name).filter(Boolean))];
        const categories = [
          ...new Set(
            rows
              .map((r) => (r.category ? String(r.category).trim() : ''))
              .filter(Boolean)
          ),
        ].sort();
        catalog = { names, categories };
      }
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
