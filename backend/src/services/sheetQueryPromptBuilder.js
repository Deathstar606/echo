const {
  getSchema,
  normalizeEntityName,
  validateFilter,
  validateSort,
  validateMutation,
} = require('./sheetSchemaService');
const { generateAiSheetInterpretation } = require('./geminiService');
const AppError = require('../utils/AppError');

/**
 * Builds the natural-language prompt instructing Gemini to convert a spreadsheet query/mutation
 * into structured JSON according to the single products schema (based on products.csv).
 *
 * @param {object} params
 * @param {string} [params.entity='products'] - Must resolve to 'products'
 * @param {string} params.message - Raw user natural language prompt
 * @param {boolean} [params.isMutation=false] - Whether a mutation is expected
 * @param {string} [params.currentDate] - Current reference date in YYYY-MM-DD
 * @returns {string}
 */
function buildSheetQueryPrompt({
  entity = 'products',
  message,
  isMutation = false,
  currentDate = new Date().toISOString().slice(0, 10),
}) {
  const schema = getSchema(entity);
  const columnsList = Object.entries(schema.columns)
    .filter(([, def]) => !def.readonly)
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
You are a precise spreadsheet query and mutation interpreter for a single-sheet product catalog management system (backed by products.csv).

OBJECTIVE
Translate the user's natural language request into a strictly structured JSON query or mutation for the "${schema.entity}" table.
${isMutation ? 'Note: The user is invoking the mutation endpoint, so prefer interpreting actionable change requests as "update", "create", or "delete" operations.' : ''}

CURRENT REFERENCE DATE
Today's date is: ${currentDate}

ENTITY SCHEMA: "${schema.entity}"
Table: ${schema.tableName}
Available fields:
${columnsList}

DATASET CONVENTIONS (products.csv)
- "name": Product title (e.g., "OpenWeave Shirt", "Classic Short-Sleeve Polo", "PleatWave Shirt", "Granular Texture Polo Shirt", "Sparkle fusion Shirt", "Retro Knit Polo Shirt", "Floral Half Sleeve Shirt", "Palm Breeze Shirt").
- "category": Apparel category. Common values in the catalog are "shirt", "polo", "full shirt", "luxury shirt", "luxury polo", "summer shirt".
- "description": Full product details including fabric composition (e.g., cotton, polyester, spandex, bamboo fiber, linen), GSM, fit (Slim Fit, Regular Fit, Relaxed Fit, Drop Shoulder), care instructions, and measurements.
- "best": Boolean flag indicating whether the product is a best-seller (true or false).
- "color": Comma-separated list of available colors (e.g., "White, Black", "Beige", "Blue, Sage green, Terracotta, Charcoal", "Mustard, Black").
- "discount": Percentage discount as a number (e.g., 25, 45).
- "ordered": Integer count of orders placed for the product (e.g., 0, 1, 2).
- "images": Comma-separated list of product image URLs.
- "size": JSON string mapping size labels (M, L, XL, XXL, XXXL) to stock counts, e.g. '{"M":2,"L":4,"XL":2,"XXL":2}'.
- "price": Numeric price of the product (e.g., 990, 1190, 1290, 1350, 1490, 1650, 1690, 1790, 2590).

SEMANTIC MAPPING RULES
1. Best-Seller Filtering ("best"):
   - "best sellers", "best-selling products", "top picks", "best products", "featured items", "where best is true" -> {"field": "best", "operator": "equals", "value": true}
   - "non-best sellers", "not best sellers", "where best is false" -> {"field": "best", "operator": "equals", "value": false}

2. Category Filtering ("category"):
   - Specific category named (e.g., "in category luxury shirt", "summer shirts", "full shirts", "luxury polo") -> {"field": "category", "operator": "equals", "value": "luxury shirt"} (use lowercase category name: "shirt", "polo", "full shirt", "luxury shirt", "luxury polo", "summer shirt").
   - If the user asks broadly for "all polo shirts" or "any polo category", you may use {"field": "category", "operator": "contains", "value": "polo"}.

3. Color & Size Filtering ("color", "size"):
   - Because "color" stores comma-separated colors (e.g. "White, Black"), filter by a specific color using "contains" or "equals", e.g. "black products" or "available in Black" -> {"field": "color", "operator": "contains", "value": "Black"}.
   - Because "size" stores a JSON map of available sizes (e.g. '{"M":2,"L":4,"XL":2,"XXL":2}'), filter for a specific size using "contains" or "equals" with the size code, e.g. "available in size M" or "size XXXL" -> {"field": "size", "operator": "contains", "value": "M"} (or "XXXL").

4. Price, Discount, and Ordered Comparisons ("price", "discount", "ordered"):
   - "price above 1500", "costs over 1500", "more than 1500" -> {"field": "price", "operator": "greater_than", "value": 1500}
   - "price below 1300", "cheaper than 1300", "under 1300" -> {"field": "price", "operator": "less_than", "value": 1300}
   - "discount above 30%", "more than 30% discount" -> {"field": "discount", "operator": "greater_than", "value": 30}
   - "discount is 45%" -> {"field": "discount", "operator": "equals", "value": 45}
   - "products with orders", "ordered at least once", "ordered > 0" -> {"field": "ordered", "operator": "greater_than", "value": 0}
   - "products with 0 orders", "never ordered", "un-ordered products" -> {"field": "ordered", "operator": "equals", "value": 0}
   - "ordered 2 times" -> {"field": "ordered", "operator": "equals", "value": 2}

5. Combined Criteria & Description Search:
   - "Find black shirts in size XL under 1500" ->
     {"field": "color", "operator": "contains", "value": "Black"},
     {"field": "size", "operator": "contains", "value": "XL"},
     {"field": "price", "operator": "less_than", "value": 1500}
   - "Find products made of bamboo fiber or spandex" -> use "description" with operator "contains".
   - "Slim fit shirts" -> {"field": "description", "operator": "contains", "value": "Slim Fit"}

6. Sorting & Limits:
   - "cheapest products", "lowest price" -> sort: [{"field": "price", "direction": "asc"}]
   - "most expensive products", "highest price" -> sort: [{"field": "price", "direction": "desc"}]
   - "most ordered products", "top ordered" -> sort: [{"field": "ordered", "direction": "desc"}]
   - "highest discount" -> sort: [{"field": "discount", "direction": "desc"}]
   - "top 5", "first 3" -> limit: 5 (or 3)

7. Dates ("created_at"):
   - "created during the last 30 days", "past 30 days" -> {"field": "created_at", "operator": "relative_days_ago", "value": 30}
   - "created this month" -> {"field": "created_at", "operator": "this_month", "value": true}

8. Mutations (Updates / Deletions / Creation):
   - "Change the price of OpenWeave Shirt to 1450" ->
     operation: "update",
     target_filters: [{"field": "name", "operator": "equals", "value": "OpenWeave Shirt"}],
     changes: {"price": 1450}
   - "Set discount of Palm Breeze Shirt to 35 and mark it as a best seller" ->
     operation: "update",
     target_filters: [{"field": "name", "operator": "equals", "value": "Palm Breeze Shirt"}],
     changes: {"discount": 35, "best": true}
   - "Update ordered count for PleatWave Shirt to 5" ->
     operation: "update",
     target_filters: [{"field": "name", "operator": "equals", "value": "PleatWave Shirt"}],
     changes: {"ordered": 5}
   - "Delete Palm Breeze Shirt" ->
     operation: "delete",
     target_filters: [{"field": "name", "operator": "equals", "value": "Palm Breeze Shirt"}],
     changes: {}

9. Ambiguity & Schema Limitations:
   - There is NO "services" table anymore—only the "products" table exists.
   - If the request references columns NOT present in the products schema (e.g., "supplier", "warehouse", "hourly rate", "technician", "weight"), DO NOT invent them. Return status "clarification_needed" explaining that the column does not exist in the products schema.
   - If a mutation request is missing the target product or the new value to set (e.g., "Update the discount of OpenWeave Shirt" without specifying the new discount percentage), return status "clarification_needed" asking for the missing detail.

OUTPUT FORMAT (Return valid JSON only)
For successful query:
{
  "status": "ok",
  "message": "",
  "entity": "products",
  "operation": "filter",
  "filters": [
    {
      "field": "best",
      "operator": "equals",
      "value": true
    }
  ],
  "sort": [],
  "limit": null
}

For clarification:
{
  "status": "clarification_needed",
  "message": "What new discount percentage would you like to set for OpenWeave Shirt?",
  "entity": "products",
  "operation": null,
  "filters": [],
  "sort": [],
  "limit": null
}

For successful mutation:
{
  "status": "ok",
  "message": "Update price of OpenWeave Shirt to 1450",
  "entity": "products",
  "operation": "update",
  "target_filters": [
    {
      "field": "name",
      "operator": "equals",
      "value": "OpenWeave Shirt"
    }
  ],
  "changes": {
    "price": 1450
  }
}

USER MESSAGE:
<user_message>
${message}
</user_message>
`;
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

  // If mutation operation (update, delete, create)
  if (operation === 'update' || operation === 'delete' || operation === 'create') {
    try {
      const validatedMut = validateMutation(normalizedEntity, {
        operation,
        target_filters: parsed.target_filters || parsed.filters || [],
        changes: parsed.changes || {},
      });
      return {
        status: 'ok',
        message: String(parsed.message || '').trim(),
        entity: normalizedEntity,
        operation: validatedMut.operation,
        target_filters: validatedMut.target_filters,
        changes: validatedMut.changes,
      };
    } catch (err) {
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
  const rawFilters = Array.isArray(parsed.filters) ? parsed.filters : [];
  const validatedFilters = [];

  for (const f of rawFilters) {
    try {
      validatedFilters.push(validateFilter(normalizedEntity, f));
    } catch (err) {
      // If a filter uses an invalid field or operator, explain limitation
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

  return {
    status: 'ok',
    message: String(parsed.message || '').trim(),
    entity: normalizedEntity,
    operation: 'filter',
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
 * @returns {Promise<object>}
 */
async function interpretNaturalLanguageQuery({
  entity = 'products',
  message,
  isMutation = false,
  currentDate,
}) {
  const normalizedEntity = normalizeEntityName(entity || 'products');

  if (typeof message !== 'string' || !message.trim()) {
    throw new AppError('Message is required and must be a non-empty string.', 400);
  }

  const promptText = buildSheetQueryPrompt({
    entity: normalizedEntity,
    message: message.trim(),
    isMutation,
    currentDate,
  });

  const rawAiResult = await generateAiSheetInterpretation(promptText);
  return normalizeInterpretedQuery(normalizedEntity, rawAiResult);
}

module.exports = {
  buildSheetQueryPrompt,
  normalizeInterpretedQuery,
  interpretNaturalLanguageQuery,
};
