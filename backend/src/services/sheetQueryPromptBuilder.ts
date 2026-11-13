/**
 * MaxiText AI Studio — Google AI Studio Gemini Sheet Query & Mutation Service
 *
 * Grounded natural-language prompt construction, LLM dispatch, untrusted JSON
 * parsing and strict schema-driven normalization.
 */

import type {
  SheetSchema,
  InterpretedSheetAction,
  QueryFilter,
  QuerySort,
  MutationOperation,
  MutationFilterLogic,
  ClarificationResponse,
  ConversationHistoryTurn,
} from '../../../shared/types/contracts';

import {
  validateRawGeminiInterpretation,
  normalizeMutationOperationAlias,
  isNonEmptyString,
} from './sheetValidationService';

// Ambient declaration for CommonJS require interop without requiring @types/node in compilerOptions
declare function require(name: string): any;

// Legacy CommonJS modules
const {
  getSchema,
  discoverTableSchema,
  validateFilter,
  validateSort,
  validateMutation,
} = require('./sheetSchemaService');
const { generateAiSheetInterpretation } = require('./geminiService');
const { loadCatalogPromptContext } = require('./catalogNameResolver');
const {
  normalizeConversationHistory,
  getLatestActiveContext,
  formatConversationHistoryForPrompt,
} = require('../utils/conversationHistory');
const AppError = require('../utils/AppError');

const MAX_PROMPT_CATALOG_NAMES = 8;
const MAX_PROMPT_CATEGORIES = 6;

export interface CatalogContext {
  names?: string[];
  categories?: string[];
}

export interface BuildPromptParams {
  entity?: string | SheetSchema;
  schema?: SheetSchema | null;
  message: string;
  isMutation?: boolean;
  currentDate?: string;
  catalog?: CatalogContext | null;
  conversationHistory?: ConversationHistoryTurn[] | Array<Record<string, any>>;
  compactPrompt?: boolean;
}

export interface InterpretQueryParams {
  entity?: string | SheetSchema;
  message: string;
  isMutation?: boolean;
  currentDate?: string;
  businessId?: string;
  schema?: SheetSchema | null;
  skipCatalogLoad?: boolean;
  catalog?: CatalogContext | null;
  responseSchema?: object | null;
  conversationHistory?: ConversationHistoryTurn[] | Array<Record<string, any>>;
  compactPrompt?: boolean;
}

/**
 * Formats live catalog context (names + distinct categories/brands) for prompt grounding.
 */
export function formatCatalogContext(catalog?: CatalogContext | null): string {
  const names = Array.isArray(catalog?.names) ? catalog.names : [];
  const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];

  if (names.length === 0 && categories.length === 0) {
    return 'LIVE CATALOG CONTEXT\n(No catalog entries found for this request. Copy names and filters exactly as user wrote them.)';
  }

  const shownNames = names.slice(0, MAX_PROMPT_CATALOG_NAMES);
  const shownCategories = categories.slice(0, MAX_PROMPT_CATEGORIES);
  const lines = ['LIVE CATALOG CONTEXT (loaded from the database for this business)'];
  if (shownCategories.length > 0) {
    lines.push(
      `Known category/brand values: ${shownCategories.map((c) => JSON.stringify(c)).join(', ')}`
    );
  }
  if (shownNames.length > 0) {
    lines.push(
      `Representative item/product names (up to ${MAX_PROMPT_CATALOG_NAMES} shown):`
    );
    for (const n of shownNames) {
      lines.push(`- ${JSON.stringify(n)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Builds the natural-language prompt instructing Gemini to convert a spreadsheet query/mutation
 * into structured JSON according to the active table's dynamically discovered schema.
 */
export function buildSheetQueryPrompt({
  entity = 'products',
  schema: explicitSchema = null,
  message,
  isMutation = false,
  currentDate = new Date().toISOString().slice(0, 10),
  catalog = null,
  conversationHistory = [],
  compactPrompt = false,
}: BuildPromptParams): string {
  const schema: SheetSchema = explicitSchema || getSchema(entity);
  const normalizedHistory = normalizeConversationHistory(conversationHistory);
  const activeContext = getLatestActiveContext(normalizedHistory, schema.tableName || schema.entity);
  const formattedHistory = formatConversationHistoryForPrompt(normalizedHistory);
  const pkHint = schema.primaryKey || 'id';
  const contextBlock = formattedHistory
    ? `\nCONVERSATION CONTEXT (last ${normalizedHistory.length} turn(s); active table: ${activeContext.activeTargetTable || schema.tableName}; prior matched_row_ids on this table: ${JSON.stringify((activeContext.matchedRowIds || []).slice(0, 40))}; prior filter summary: ${JSON.stringify(activeContext.appliedFilterSummary || '')}; identifier column: ${pkHint}):\n${formattedHistory}\n`
    : '';

  const columnsList = Object.entries(schema.columns)
    .filter(([, def]) => isMutation || def.queryable !== false)
    .map(([, def]) => {
      const colName = def.exactName || (def as unknown as string);
      const modifiable = def.modifiable && !def.virtual;
      let desc = isMutation
        ? `- ${colName} (${def.type}) [${modifiable ? 'modifiable' : 'read-only'}]`
        : `- ${colName} (${def.type})`;
      if (isMutation && def.storageType) {
        desc += ` [PostgreSQL: ${def.storageType}]`;
      }
      if (colName.toLowerCase() === 'id' && def.type === 'uuid') {
        desc += ` (internal system record UUID; do NOT filter with domain codes like Order ID, SKU, or name; use ${pkHint !== 'id' ? pkHint : 'the business identifier column'} instead)`;
      } else if (def.description) {
        desc += `: ${def.description}`;
      }
      if (def.nestedMap) {
        const structure = def.nestedStructure
          ? Object.entries(def.nestedStructure)
              .map(([key, type]) => `${key}:${type}`)
              .join(', ')
          : 'object with record-specific keys';
        desc += ` [nested map; keys: ${structure}]`;
      }
      if (def.allowedValues) {
        desc += ` [values: ${def.allowedValues.map((v) => `"${v}"`).join(', ')}]`;
      }
      return desc;
    })
    .join('\n');

  const repLines: string[] = [];
  if (schema.representativeValues && Object.keys(schema.representativeValues).length > 0) {
    const cap = isMutation ? 6 : 8;
    for (const [col, vals] of Object.entries(schema.representativeValues)) {
      if (Array.isArray(vals) && vals.length > 0) {
        repLines.push(
          `- ${col}: ${vals
            .slice(0, cap)
            .map((value) => JSON.stringify(value))
            .join(', ')}`
        );
      }
    }
  }
  const representativeValuesBlock =
    repLines.length > 0
      ? `Representative values:\n${repLines.join('\n')}`
      : '';

  const catalogBlock =
    catalog && ((catalog.names && catalog.names.length > 0) || (catalog.categories && catalog.categories.length > 0))
      ? `\n${formatCatalogContext(catalog)}\n`
      : '';

  if (!isMutation) {
    if (compactPrompt) {
      return `Convert this request into a read-only JSON filter plan for the active table. Use only its exact columns; never mutate data or invent fields.

TABLE
Table: ${schema.tableName} (${schema.entity})
${columnsList}
${representativeValuesBlock}
${catalogBlock}
RULES
- Map business terms using column names, types, descriptions, and representative values.
- Use exact field names and supported operators: equals, not_equals, contains, not_contains, starts_with, ends_with, in, greater_than, greater_than_or_equal, less_than, less_than_or_equal, between, relative_days_ago, this_month.
- Multiple conditions use AND unless the user explicitly requests OR. Clarify only if the requested table/filter cannot be safely mapped.
- CONVERSATION FOLLOW-UPS: If CONVERSATION CONTEXT is present and user query narrows/refines prior results (e.g. "those", "from khulna", "delayed ones", "only those"), chain prior active filters on this table unless user explicitly asks to reset scope.
- Return only JSON shaped as {"status":"ok","entity":"${schema.entity}","operation":"filter","filter_logic":"AND","filters":[{"field":"...","operator":"equals","value":"..."}],"sort":[],"limit":null} or {"status":"clarification_needed","message":"..."}.
Reference date: ${currentDate}
${contextBlock}
USER REQUEST
<user_message>
${message}
</user_message>`;
    }

    return `You are translating a BASIC SINGLE-TABLE READ INQUIRY into a SQL filter JSON object.
Do NOT treat this as a mutation, email action, or B2B document/policy workflow. Never output update/create/delete. Use ONLY this active table's columns and metadata below.

ACTIVE TABLE SCHEMA
Table: ${schema.tableName} (${schema.entity})
${columnsList}
${representativeValuesBlock ? `\n${representativeValuesBlock}\n` : ''}${catalogBlock}
RULES
- Use exact schema column names only; never invent fields. Match user terms to column names and representative values (e.g., "already shipped" -> status equals "Shipped", "priority" -> buyer_tier equals "Priority", "higher than 25%" -> greater_than 25, "stock lower than 5" -> total_stock less_than 5 if present, or specific key like size.M).
- Multiple conditions default to filter_logic: "AND" ("OR" only when requested). Supported operators: equals, not_equals, contains, not_contains, starts_with, ends_with, in, greater_than, greater_than_or_equal, less_than, less_than_or_equal, between, relative_days_ago, this_month.
- Return JSON only:
  {"status":"ok","entity":"${schema.entity}","operation":"filter","filter_logic":"AND","filters":[{"field":"...","operator":"...","value":...}],"sort":[{"field":"...","direction":"asc|desc"}],"limit":null}
  Or {"status":"clarification_needed","message":"..."} only if the request genuinely cannot map to any column here.
- CONVERSATION FOLLOW-UPS: If CONVERSATION CONTEXT is present and USER QUERY narrows/refines prior results (e.g. "those", "them", "only the ones...", "filter those by...", "with zero..."), chain the active prior filters on this table AND add the new condition(s) (do NOT drop prior filtering criteria unless the user explicitly asks to search all rows / reset scope).
Reference date: ${currentDate}
${contextBlock}
USER QUERY:
<user_message>
${message}
</user_message>
`;
  }

  const nestedMapColumns = Object.values(schema.columns)
    .filter((def) => def.nestedMap && def.modifiable)
    .map((def) => def.exactName);
  const nestedMapInstructions = nestedMapColumns.length
    ? `\nNested map columns: ${nestedMapColumns.join(', ')}. A dotted field targets one explicit key. For an operation over every key already in each matching row, use action "add_to_existing_values", "subtract_existing_values", "multiply_existing_values", or "set_existing_values" with key_policy "existing_keys_only". Iterate each row's own keys; never infer/union keys from other records or samples.`
    : '';

  if (compactPrompt) {
    return `Convert this table-local request into a validated spreadsheet JSON plan. Use exact columns and schema metadata only; clarify unsupported or ambiguous intent. Never return SQL.

TABLE
Table: ${schema.tableName} (${schema.entity})
${columnsList}
${representativeValuesBlock}
${catalogBlock}
${nestedMapInstructions}

RULES
- Read: operation "filter". Updates: "update" or "update_many" with target_filters and updates [{field,action,value,unit}]; action is set, add, subtract, or multiply, and unit is absolute, percentage, or percentage_points.
- Default filter logic to AND; use OR only when explicitly requested. Use only modifiable columns for updates.
- For nested maps, explicit keys use dotted fields. Apply to every key present in each row only with the existing-values actions and key_policy "existing_keys_only"; never create missing keys unless explicitly requested.
- For create, include only explicitly supplied fields. For delete/update, require a safe target scope; set match_all:true only on an explicit request to affect all rows. Ask for clarification if scope or intent is unclear.
- CONVERSATION SCOPE INHERITANCE: If CONVERSATION CONTEXT is present with prior matched_row_ids or prior filters on this table and the user updates/deletes without restating a WHERE clause (or says "those", "them", "that one", "increase discount to 20%"), scope "target_filters" to those prior rows (or filter ${pkHint} with operator "in" and the prior matched_row_ids) and set match_all:false.
- Return JSON only. Read: {"status":"ok","entity":"${schema.entity}","operation":"filter","filter_logic":"AND","filters":[{"field":"...","operator":"equals","value":"..."}],"sort":[],"limit":null}. Mutation: {"status":"ok","entity":"${schema.entity}","operation":"update","filter_logic":"AND","match_all":false,"target_filters":[{"field":"...","operator":"equals","value":"..."}],"updates":[{"field":"...","action":"add","value":1,"unit":"absolute"}]}. Clarification: {"status":"clarification_needed","message":"..."}.
Reference date: ${currentDate}
${contextBlock}
USER REQUEST
<user_message>
${message}
</user_message>`;
  }

  return `Interpret the user's request as a safe spreadsheet query or mutation plan.

ACTIVE TABLE SCHEMA
Table: ${schema.tableName} (${schema.entity})

COMPLETE SCHEMA (exact database identifiers; logical type, storage type, mutability, metadata)
${columnsList}
${representativeValuesBlock ? `\n${representativeValuesBlock}\n` : ''}${catalogBlock}
${nestedMapInstructions}

INTERPRETATION RULES
- Classify intent dynamically: read query ("filter"), update ("update" / "update_many"), insert ("create"), or delete ("delete").
- Use exact schema column names only; never invent fields. Map business concepts using field names, descriptions, types, nested structure, and representative values.
- Distinguish selling price from purchase/unit cost, and percentage-valued fields (e.g. discount) from monetary fields. If target field, condition, value, or scope is missing or ambiguous, return {"status":"clarification_needed","message":"..."}.
- Query filters and mutation target_filters use {field,operator,value}; filter_logic defaults to "AND" ("OR" only when stated). Set match_all:true only when explicitly targeting all rows.
- CONVERSATION SCOPE INHERITANCE: If CONVERSATION CONTEXT is present with prior matched_row_ids or prior filters on this table and the user issues a follow-up update/delete without restating a WHERE clause (or says "those", "them", "that unit", "increase the discount to 20%"), scope "target_filters" to those prior rows (either re-apply the active prior filter criteria OR filter ${pkHint} with operator "in" and the prior matched_row_ids) and set match_all:false. Never emit clarification_needed merely because the target filter came from a previous turn in CONVERSATION CONTEXT. If CONVERSATION CONTEXT is empty and no filter or explicit whole-table wording is given, preserve safety and ask for clarification or match_all:true so safeguards apply.
- Updates ("update"/"update_many"): updates array of {field,action:"set"|"add"|"subtract"|"multiply",value,unit:"absolute"|"percentage"|"percentage_points"}. Every updated field must be a modifiable schema column.
- Nested maps: dotted field (e.g. "size.M") targets one key (key_policy:"existing_keys_only", or "create_if_missing" if requested). For all existing keys in each row, use action "add_to_existing_values"|"subtract_existing_values"|"multiply_existing_values"|"set_existing_values" with key_policy:"existing_keys_only" and no keys list.
- Insert ("create"): include only user-specified columns in changes ({col:val}), updates, or rows ([{col:val},...] for multi-row). For nested maps use dotted fields or JSON object. If no attributes are given, return clarification_needed.
- Delete ("delete"): populate target_filters (use operator "in" or filter_logic "OR" for multiple named items; match_all:true only if deleting all rows). If criteria are missing, return clarification_needed.

OUTPUT (JSON only — omit unused/empty keys to minimize output tokens)
- Read query: {"status":"ok","entity":"${schema.entity}","operation":"filter","filter_logic":"AND","filters":[...],"sort":[...],"limit":null}
- Update: {"status":"ok","entity":"${schema.entity}","operation":"update|update_many","filter_logic":"AND","match_all":false,"target_filters":[...],"updates":[...]}
- Insert: {"status":"ok","entity":"${schema.entity}","operation":"create","changes":{...}} (or "rows":[{...}] for multiple rows)
- Delete: {"status":"ok","entity":"${schema.entity}","operation":"delete","filter_logic":"AND","target_filters":[...]}
- Clarification: {"status":"clarification_needed","message":"..."}

Reference date: ${currentDate}
Request mode: ${isMutation ? 'mutation' : 'query'}

${formatCatalogContext(catalog)}
${contextBlock}
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
 */
export function isHardConstraintValidationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
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
 * Strictly checks untrusted input before constructing typed output.
 */
export function normalizeInterpretedQuery(
  entityOrSchema: string | SheetSchema,
  raw: unknown
): InterpretedSheetAction {
  const schema: SheetSchema = getSchema(entityOrSchema);
  const normalizedEntity = schema.entity;

  const parsed = validateRawGeminiInterpretation(raw);

  if (parsed.status === 'clarification_needed' || !parsed.operation) {
    return {
      status: 'clarification_needed',
      message: String(parsed.message || 'Could not interpret request into a structured spreadsheet query.').trim(),
      entity: normalizedEntity,
      operation: null,
      filters: [],
      sort: [],
      limit: null,
    };
  }

  const operation = normalizeMutationOperationAlias(parsed.operation);

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
        changes: parsed.changes || parsed.row || parsed.record || {},
        rows: parsed.rows || parsed.records,
      });
      return {
        status: 'ok',
        message: String(parsed.message || '').trim(),
        entity: normalizedEntity,
        operation: validatedMut.operation as MutationOperation,
        filter_logic: validatedMut.filter_logic as MutationFilterLogic,
        match_all: Boolean(validatedMut.match_all),
        target_filters: validatedMut.target_filters,
        updates: validatedMut.updates,
        changes: validatedMut.changes || {},
        ...(Array.isArray(validatedMut.rows) && validatedMut.rows.length > 0
          ? { rows: validatedMut.rows }
          : {}),
      };
    } catch (err: unknown) {
      if (isHardConstraintValidationError(err)) {
        throw err;
      }
      return {
        status: 'clarification_needed',
        message: err instanceof Error ? err.message : String(err),
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
  const validatedFilters: QueryFilter[] = [];

  for (const f of rawFilters) {
    try {
      validatedFilters.push(validateFilter(schema, f));
    } catch (err: unknown) {
      return {
        status: 'clarification_needed',
        message: `Schema limitation: ${err instanceof Error ? err.message : String(err)}`,
        entity: normalizedEntity,
        operation: null,
        filters: [],
        sort: [],
        limit: null,
      };
    }
  }

  let validatedSort: QuerySort[] = [];
  try {
    validatedSort = validateSort(schema, parsed.sort || []);
  } catch {
    validatedSort = [];
  }

  let limit: number | null = null;
  if (parsed.limit !== null && parsed.limit !== undefined) {
    const parsedLimit = Number.parseInt(String(parsed.limit), 10);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      limit = Math.min(parsedLimit, 500);
    }
  }

  const rawFilterLogic = String(
    parsed.filter_logic || parsed.logical_operator || 'AND'
  )
    .trim()
    .toUpperCase();
  const filterLogic: 'AND' | 'OR' = rawFilterLogic === 'OR' ? 'OR' : 'AND';

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
 */
export async function interpretNaturalLanguageQuery({
  entity = 'products',
  message,
  isMutation = false,
  currentDate,
  businessId,
  schema: suppliedSchema = null,
  skipCatalogLoad = false,
  catalog: suppliedCatalog = null,
  responseSchema = null,
  conversationHistory = [],
  compactPrompt = false,
}: InterpretQueryParams): Promise<InterpretedSheetAction> {
  if (!isNonEmptyString(message)) {
    throw new AppError('Message is required and must be a non-empty string.', 400);
  }

  // 1. Dynamically discover the schema of the active table
  const schema: SheetSchema =
    suppliedSchema || (await discoverTableSchema(entity, businessId));

  // 2. Load catalog names only when not skipped/pre-supplied
  let catalog: CatalogContext | null = suppliedCatalog || null;
  if (!catalog && businessId && !skipCatalogLoad) {
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
    conversationHistory,
    compactPrompt,
  });

  // 4. Send to Gemini for interpretation
  const rawAiResult = await generateAiSheetInterpretation(promptText, responseSchema);

  // 5. Normalize and validate against the active table schema
  return normalizeInterpretedQuery(schema, rawAiResult);
}
