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
 * into structured JSON according to the schema.
 *
 * @param {object} params
 * @param {string} params.entity - 'products' | 'services'
 * @param {string} params.message - Raw user natural language prompt
 * @param {boolean} [params.isMutation=false] - Whether a mutation is expected
 * @param {string} [params.currentDate] - Current reference date in YYYY-MM-DD
 * @returns {string}
 */
function buildSheetQueryPrompt({
  entity,
  message,
  isMutation = false,
  currentDate = new Date().toISOString().slice(0, 10),
}) {
  const schema = getSchema(entity);
  const columnsList = Object.entries(schema.columns)
    .filter(([, def]) => !def.readonly)
    .map(([col, def]) => {
      let desc = `- "${col}" (${def.type})`;
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
You are a precise spreadsheet query and mutation interpreter for an inventory and services management system.

OBJECTIVE
Translate the user's natural language request into a strictly structured JSON query or mutation for the "${schema.entity}" table.

CURRENT REFERENCE DATE
Today's date is: ${currentDate}

ENTITY SCHEMA: "${schema.entity}"
Table: ${schema.tableName}
Available fields:
${columnsList}

SEMANTIC MAPPING RULES
1. Products Stock vs Availability:
   - "out of stock", "unavailable products", "no stock left", "stock is 0" -> {"field": "stock", "operator": "equals", "value": 0}
   - "in stock", "available products", "has stock" -> {"field": "stock", "operator": "greater_than", "value": 0}

2. Services Availability:
   - "unavailable services", "services not available", "not available" -> {"field": "availability", "operator": "equals", "value": "unavailable"}
   - "available services" -> {"field": "availability", "operator": "equals", "value": "available"}

3. Comparisons:
   - "price above 100", "costs over 100", "more than 100" -> {"field": "price", "operator": "greater_than", "value": 100}
   - "price below 50", "cheaper than 50" -> {"field": "price", "operator": "less_than", "value": 50}
   - "rate below 100", "under 100/hr" -> {"field": "rate", "operator": "less_than", "value": 100}
   - "more than 10 units in stock", "stock above 10" -> {"field": "stock", "operator": "greater_than", "value": 10}

4. Combined Criteria:
   - "Find red products in size XL" -> two filters:
     {"field": "color", "operator": "equals", "value": "Red"},
     {"field": "size", "operator": "equals", "value": "XL"}
   - "matching this description: waterproof and lightweight" -> two description filters:
     {"field": "description", "operator": "contains", "value": "waterproof"},
     {"field": "description", "operator": "contains", "value": "lightweight"}
   - "Find products priced below 50 with more than 10 units in stock" ->
     {"field": "price", "operator": "less_than", "value": 50},
     {"field": "stock", "operator": "greater_than", "value": 10}

5. Dates:
   - "created during the last 30 days", "past 30 days" -> {"field": "created_at", "operator": "relative_days_ago", "value": 30}
   - "services created this month" -> {"field": "created_at", "operator": "this_month", "value": true}
   - "available after a specified date" ->
     * If user explicitly mentions a date (e.g. "after November 1, 2026" or "after 2026-11-01"): {"field": "available_from", "operator": "greater_than", "value": "2026-11-01"}
     * If user literally says "available after a specified date" or "after a date" WITHOUT providing the date, return status "clarification_needed".

6. Text search / topics:
   - "Find services related to home renovation" -> {"field": "description", "operator": "contains", "value": "home renovation"}

7. Mutations (Updates / Deletions / Creation):
   - "Change the price of product X to 150." -> operation: "update", target_filters: [{"field": "name", "operator": "equals", "value": "X"}], changes: {"price": 150}
   - "Set the stock of product X to zero." -> operation: "update", target_filters: [{"field": "name", "operator": "equals", "value": "X"}], changes: {"stock": 0}
   - "Update the availability of service X." -> If new state (available/unavailable) is NOT given, return status "clarification_needed" asking what to set the availability to.

8. Ambiguity & Limitations:
   - If the request references columns NOT present in the schema (e.g. weight, brand, technician, warehouse), DO NOT invent them. Return status "clarification_needed" explaining the column is not in the schema.
   - If the request is unclear, missing critical parameters, or cannot be safely determined, return status "clarification_needed" with a polite clarification message.

OUTPUT FORMAT (Return valid JSON only)
For successful query:
{
  "status": "ok",
  "message": "",
  "entity": "${schema.entity}",
  "operation": "filter",
  "filters": [
    {
      "field": "stock",
      "operator": "equals",
      "value": 0
    }
  ],
  "sort": [],
  "limit": null
}

For clarification:
{
  "status": "clarification_needed",
  "message": "Which date should I use for checking service availability?",
  "entity": "${schema.entity}",
  "operation": null,
  "filters": [],
  "sort": [],
  "limit": null
}

For successful mutation:
{
  "status": "ok",
  "message": "Change price of product X to 150",
  "entity": "${schema.entity}",
  "operation": "update",
  "target_filters": [
    {
      "field": "name",
      "operator": "equals",
      "value": "Trail Rain Jacket"
    }
  ],
  "changes": {
    "price": 150
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
 * @param {string} entity
 * @param {object} parsed
 * @returns {object}
 */
function normalizeInterpretedQuery(entity, parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      status: 'clarification_needed',
      message: 'Could not interpret request into a structured spreadsheet query.',
      entity,
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
      entity,
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
      const validatedMut = validateMutation(entity, {
        operation,
        target_filters: parsed.target_filters || parsed.filters || [],
        changes: parsed.changes || {},
      });
      return {
        status: 'ok',
        message: String(parsed.message || '').trim(),
        entity,
        operation: validatedMut.operation,
        target_filters: validatedMut.target_filters,
        changes: validatedMut.changes,
      };
    } catch (err) {
      return {
        status: 'clarification_needed',
        message: err.message,
        entity,
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
      validatedFilters.push(validateFilter(entity, f));
    } catch (err) {
      // If a filter uses an invalid field or operator, explain limitation
      return {
        status: 'clarification_needed',
        message: `Schema limitation: ${err.message}`,
        entity,
        operation: null,
        filters: [],
        sort: [],
        limit: null,
      };
    }
  }

  let validatedSort = [];
  try {
    validatedSort = validateSort(entity, parsed.sort || []);
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
    entity,
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
 * @param {string} params.entity - 'products' | 'services'
 * @param {string} params.message - user natural language prompt
 * @param {boolean} [params.isMutation=false]
 * @param {string} [params.currentDate]
 * @returns {Promise<object>}
 */
async function interpretNaturalLanguageQuery({
  entity,
  message,
  isMutation = false,
  currentDate,
}) {
  const normalizedEntity = normalizeEntityName(entity);

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
