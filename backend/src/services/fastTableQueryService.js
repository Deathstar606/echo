const {
  discoverTableSchema,
  normalizeEntityName,
} = require('./sheetSchemaService');
const {
  listWorkspaceTableMetadataCached,
} = require('./workspaceTableMetadataService');
const {
  interpretNaturalLanguageQuery,
} = require('./sheetQueryPromptBuilder');
const {
  executeSpreadsheetQuery,
} = require('./sheetQueryService');
const {
  buildTableRowCitation,
  resolveRowIdentifier,
  resolveRowIdentifierInfo,
} = require('./crossRagService');
const {
  detectConversationalIntent,
} = require('./contextRetrievalService');
const {
  generateStructuredJsonWithRetry,
  hasCustomWorkspaceGeminiGenerator,
} = require('./geminiService');
const {
  normalizeConversationHistory,
  getLatestActiveContext,
  hasFollowUpReference,
} = require('../utils/conversationHistory');

const MUTATION_OR_ACTION_REGEX =
  /\b(?:update|set|change|modify|edit|alter|swap|replace|refund|reconcile|enforce|process|elevate|upgrade|downgrade|promote|freeze|cut|reduce|increase|decrease|adjust|add|insert|create|delete|remove|drop|allocate|deploy|assign|audit|review|email|e-mail|notify|message|alert|send|draft|dispatch|apply|mark|cancel|trigger|execute|clear|import|upload)\b/i;
const DIRECT_MUTATION_LEAD_REGEX =
  /^(?:please\s+)?(?:update|set|change|modify|edit|alter|swap|replace|increase|decrease|reduce|cut|adjust|add|subtract|multiply|mark|delete|remove|create)\b/i;
const EXTERNAL_ACTION_REGEX =
  /\b(?:email|e-mail|notify|send|alert|draft|dispatch)\b/i;
const MULTI_SOURCE_MUTATION_REGEX =
  /\b(?:based\s+on|cross[- ]?reference|cross[- ]?check|reconcile|compare\s+(?:with|against)|against\s+(?:the\s+)?(?:orders?|products?|inventory|backorders?|table|sheet|csv|dataset))\b/i;

const B2B_OR_DOC_REGEX =
  /\b(?:policy|policies|SOP|manifest|memo|brief|recall|protocol|guideline|compliance|underwriting|SLA|voucher|claim|waiver|surveyor|quarter|Q[1-4]|section\s+\d+|clause|rules?|according\s+to|cross[- ]?check|cross[- ]?reference|combine|combined|evaluate|compute|calculate|bypass|decompression|turnaround|shortage|deficit|core[- ]?size|margin\s+lock|quarantine|FIN-POL|DIR-COM|PRM-|QA_Batch|VLR-|CLM-|Allocation\s+Priority|Credit\s+Control|Hospital\s+Bed|Clinical_Staffing|Regional_Treasury|Vendor_Defect)\b|\.(?:pdf|docx?|txt|md)\b/i;

const SCOPED_POLICY_PREP_REGEX =
  /\b(?:per|under)\s+(?:the\s+)?(?:[A-Z][A-Za-z0-9_-]*|policy|policies|sop|protocol|brief|sla|manifest|memo|recall|section|clause|rule|guideline)\b/;

const READ_LEAD_REGEX =
  /^(?:show|list|find|get|search|lookup|look\s+up|fetch|filter|display|give\s+me|what|which|who|where|how\s+many|sort|top\s+\d+)\b/i;

const NON_TABLE_WHY_HOW_REGEX =
  /^(?:why|how\s+(?:do|does|did|should|can|could|would|to))\b/i;

const READ_SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: {
      type: 'STRING',
      description: 'Concise 1-2 sentence grounded summary answering the query from the returned rows.',
    },
  },
  required: ['answer'],
};

const STOP_WORDS = new Set([
  'show', 'list', 'find', 'get', 'search', 'lookup', 'look', 'fetch', 'filter',
  'display', 'give', 'me', 'all', 'the', 'with', 'without', 'and', 'or', 'for',
  'where', 'when', 'which', 'that', 'this', 'from', 'into', 'already', 'higher',
  'lower', 'greater', 'less', 'than', 'above', 'below', 'over', 'under', 'equal',
  'equals', 'not', 'are', 'is', 'was', 'were', 'has', 'have', 'had', 'in', 'on',
  'of', 'to', 'by', 'as', 'at', 'sorted', 'sort', 'descending', 'ascending',
  'desc', 'asc', 'priced', 'price', 'tier', 'rows', 'records', 'items', 'table',
]);

/**
 * Determines whether a prompt is an unambiguous single-table read query eligible
 * for the fast B2B-bypass path.
 *
 * @param {string} prompt
 * @param {Array<object>} [history=[]]
 * @returns {boolean}
 */
function isBasicTableQueryCandidate(prompt, history = []) {
  const text = String(prompt || '').trim();
  if (!text) return false;

  const conv = detectConversationalIntent(text);
  if (conv?.isConversational && (!Array.isArray(history) || history.length === 0)) {
    return false;
  }

  if (
    Array.isArray(history) &&
    history.some((turn) => /CLARIFICATION|option_|option\s+\d/i.test(String(turn?.content || ''))) &&
    /^(?:yes|no|option|do|apply|proceed|confirm|choose|select|the\s+(?:first|second|third))/i.test(text)
  ) {
    return false;
  }

  if (NON_TABLE_WHY_HOW_REGEX.test(text)) return false;
  if (!READ_LEAD_REGEX.test(text)) return false;
  if (MUTATION_OR_ACTION_REGEX.test(text)) return false;
  if (B2B_OR_DOC_REGEX.test(text) || SCOPED_POLICY_PREP_REGEX.test(text)) return false;

  return true;
}

/**
 * Identifies direct, table-local mutations that do not need document/RAG intent
 * classification. Interpretation and preview still use the existing Gemini and
 * validation pipeline; requests with history or external/document dependencies
 * are deliberately left to the normal router.
 *
 * @param {string} prompt
 * @param {Array<object>} [history=[]]
 * @returns {boolean}
 */
function isBasicTableMutationCandidate(prompt, history = []) {
  const text = String(prompt || '').trim();
  if (!text || (Array.isArray(history) && history.length > 0)) return false;
  if (!DIRECT_MUTATION_LEAD_REGEX.test(text)) return false;
  if (
    B2B_OR_DOC_REGEX.test(text) ||
    SCOPED_POLICY_PREP_REGEX.test(text) ||
    EXTERNAL_ACTION_REGEX.test(text) ||
    MULTI_SOURCE_MUTATION_REGEX.test(text)
  ) {
    return false;
  }
  return true;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandTokenVariants(rawName) {
  const base = String(rawName || '').toLowerCase();
  const parts = base.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const variants = new Set(parts);
  for (const part of parts) {
    if (part.endsWith('s') && part.length > 3) variants.add(part.slice(0, -1));
    else if (part.length > 2) variants.add(`${part}s`);
  }
  return [...variants];
}

function tokenizePromptWords(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9_.%-]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Computes a metadata score for one table using only its name, columns,
 * nested map keys, and profiled categorical values.
 */
function scoreTableAgainstPrompt(prompt, promptLower, promptWords, activeEntity, meta) {
  const tableName = String(meta.table_name || '').trim();
  const tableLower = tableName.toLowerCase();
  const spacedTableName = tableLower.replace(/_/g, ' ');
  const columns = Array.isArray(meta.columns_profile) ? meta.columns_profile : [];

  let score = 0;
  let explicitNamed = false;

  if (
    new RegExp(`\\b${escapeRegex(tableLower)}(?:\\.csv)?\\b`, 'i').test(promptLower) ||
    (spacedTableName !== tableLower &&
      new RegExp(`\\b${escapeRegex(spacedTableName)}\\b`, 'i').test(promptLower))
  ) {
    score += 12;
    explicitNamed = true;
  } else {
    const nameTokens = expandTokenVariants(tableLower).filter(
      (t) => !['dataset', 'data', 'table', 'sheet', 'management'].includes(t)
    );
    for (const token of nameTokens) {
      if (new RegExp(`\\b${escapeRegex(token)}\\b`, 'i').test(promptLower)) {
        score += 3;
      }
    }
    if (
      tableLower.includes('order') &&
      !tableLower.includes('backorder') &&
      /\borders?\b/i.test(promptLower)
    ) {
      score += 4;
    } else if (tableLower.includes('backorder') && /\borders?\b/i.test(promptLower)) {
      score += 2;
    }
  }

  for (const col of columns) {
    const rawCol = String(col.column_name || '').trim();
    const colLower = rawCol.toLowerCase();
    const spacedCol = colLower.replace(/_/g, ' ');
    if (
      colLower &&
      (new RegExp(`\\b${escapeRegex(colLower)}\\b`, 'i').test(promptLower) ||
        (spacedCol !== colLower &&
          new RegExp(`\\b${escapeRegex(spacedCol)}\\b`, 'i').test(promptLower)))
    ) {
      score += 5;
    } else if (colLower === 'price' && /\bpric(?:e|ed|es|ing)\b/i.test(promptLower)) {
      score += 4;
    } else if (
      (colLower === 'size' || colLower === 'total_stock') &&
      /\b(?:stock|stocks|inventory|units?|size)\b/i.test(promptLower)
    ) {
      score += 4;
    } else if (
      /status$/i.test(colLower) &&
      /\b(?:shipped|delivered|processing|pending|cancelled|on hold)\b/i.test(promptLower)
    ) {
      score += 2;
    }

    if (Array.isArray(col.categorical_values)) {
      let matchedCatOnCol = false;
      for (const rawVal of col.categorical_values) {
        const valStr = String(rawVal ?? '').trim().toLowerCase();
        if (valStr.length < 3 || STOP_WORDS.has(valStr)) continue;
        const valVariants = [valStr, valStr.endsWith('s') ? valStr.slice(0, -1) : `${valStr}s`];
        if (
          valVariants.some((variant) =>
            new RegExp(`\\b${escapeRegex(variant)}\\b`, 'i').test(promptLower)
          )
        ) {
          matchedCatOnCol = true;
          break;
        }
      }
      if (matchedCatOnCol) score += 4;
    }

    if (col.nested_structure?.observed_keys) {
      for (const keyObj of col.nested_structure.observed_keys) {
        const keyStr = String(keyObj?.name || '').toLowerCase();
        if (keyStr && promptWords.includes(keyStr)) {
          score += 3;
          break;
        }
      }
    }
  }

  if (
    activeEntity &&
    normalizeEntityName(activeEntity) === normalizeEntityName(tableName) &&
    score > 0
  ) {
    score += 1;
  }

  return { tableName, score, explicitNamed, meta };
}

/**
 * Selects a single unambiguous workspace table from `workspace_table_metadata`.
 * Returns `null` if 0 tables exist, if an unknown external table is referenced,
 * or if 2+ tables compete closely (falling back to the multi-table router).
 *
 * @param {string} prompt
 * @param {string | null} activeEntity
 * @param {Array<object>} metadataRows
 * @returns {{ meta: object } | null}
 */
function resolveSingleTableTarget(
  prompt,
  activeEntity,
  metadataRows = [],
  conversationHistory = []
) {
  if (!Array.isArray(metadataRows) || metadataRows.length === 0) {
    return null;
  }

  const promptLower = String(prompt || '').toLowerCase();
  const promptWords = tokenizePromptWords(prompt);
  const knownTableLower = new Set(
    metadataRows.map((m) => String(m.table_name || '').toLowerCase())
  );
  const knownColumnLower = new Set(
    metadataRows.flatMap((m) =>
      Array.isArray(m.columns_profile)
        ? m.columns_profile.map((c) => String(c.column_name || '').toLowerCase())
        : []
    )
  );

  // Bail immediately if the prompt names an external *.csv or table identifier missing from this workspace
  const externalTableMatches =
    promptLower.match(/\b[a-z0-9_]+(?:\.csv|_dataset|_inventory|_receivables|_roster)\b/gi) ||
    [];
  for (const ref of externalTableMatches) {
    const cleanRef = normalizeEntityName(ref.replace(/\.csv$/i, ''));
    if (!knownTableLower.has(cleanRef) && !knownColumnLower.has(cleanRef)) {
      return null;
    }
  }

  const normalizedHistory = normalizeConversationHistory(conversationHistory);
  const activeCtx = getLatestActiveContext(normalizedHistory, activeEntity);
  const effectiveActiveEntity = activeCtx.activeTargetTable || activeEntity || null;

  const scored = metadataRows
    .map((meta) =>
      scoreTableAgainstPrompt(prompt, promptLower, promptWords, effectiveActiveEntity, meta)
    )
    .sort((a, b) => b.score - a.score);

  const explicitlyNamed = scored.filter((item) => item.explicitNamed);
  if (explicitlyNamed.length > 1) {
    return null;
  }
  if (explicitlyNamed.length === 1) {
    return { meta: explicitlyNamed[0].meta };
  }

  // Follow-up narrowing/filtering with zero new table name inherits the prior turn's table
  if (hasFollowUpReference(prompt) && activeCtx.activeTargetTable) {
    const priorMeta = metadataRows.find(
      (m) =>
        normalizeEntityName(m.table_name) ===
        normalizeEntityName(activeCtx.activeTargetTable)
    );
    if (priorMeta) {
      return { meta: priorMeta };
    }
  }

  const top = scored[0];
  if (!top || top.score === 0) {
    if (effectiveActiveEntity) {
      const activeMeta = metadataRows.find(
        (m) => normalizeEntityName(m.table_name) === normalizeEntityName(effectiveActiveEntity)
      );
      if (activeMeta) return { meta: activeMeta };
    }
    return metadataRows.length === 1 ? { meta: metadataRows[0] } : null;
  }

  const second = scored[1];
  // If two tables tie closely without a clear active-table winner, let the router handle ambiguity
  if (second && second.score > 0 && second.score >= top.score - 1 && !explicitlyNamed.length) {
    return null;
  }

  return { meta: top.meta };
}

function redactRowForSummary(row, schema, emailColumn) {
  const emailLower = emailColumn ? String(emailColumn).toLowerCase() : null;
  const out = {};
  for (const [key, val] of Object.entries(row || {})) {
    const lower = key.toLowerCase();
    if (
      ['id', 'business_id', 'workspace_id', 'user_id', 'workspace_document_id', '_google_row_index', 'created_at', 'updated_at', 'images'].includes(
        lower
      )
    ) {
      continue;
    }
    if (emailLower && lower === emailLower) continue;
    if (/email|phone|mobile/i.test(lower)) continue;
    if (lower === 'description' && typeof val === 'string' && val.length > 60) continue;

    if (typeof val === 'string' && val.length > 90) {
      out[key] = `${val.slice(0, 87)}...`;
    } else {
      out[key] = val;
    }
  }
  return out;
}

function buildHighlightedRows(tableName, rows) {
  return rows.slice(0, 100).map((row, idx) => ({
    table_name: tableName,
    row_identifier: resolveRowIdentifier(row, idx + 1),
    row_data: row,
  }));
}

/**
 * Fast, deterministic query summarizer that synthesizes an accurate,
 * human-readable summary of matched SQL rows in 0ms without extra LLM hops.
 */
function buildDeterministicQuerySummary({
  prompt,
  tableName,
  interpreted = {},
  rows = [],
  schema = {},
}) {
  const count = Array.isArray(rows) ? rows.length : 0;
  const displayTable = tableName || 'table';

  if (count === 0) {
    const filters = Array.isArray(interpreted?.filters) ? interpreted.filters : [];
    if (filters.length > 0) {
      const criteria = filters
        .map((f) => `${f.column || f.field || 'field'} ${f.operator || '='} "${f.value}"`)
        .join(', ');
      return `Found 0 matching record(s) in ${displayTable} for criteria: ${criteria}.`;
    }
    return `Found 0 matching record(s) in ${displayTable} matching the specified query.`;
  }

  const descriptors = rows.slice(0, 5).map((row, idx) => {
    const idInfo = resolveRowIdentifierInfo(row, idx + 1);
    const id = idInfo.identifier;

    // Search for a secondary human-readable name or title if id is an alphanumeric code
    let descriptor = '';
    const nameCols = [
      'customer_name',
      'name',
      'product_name',
      'item_name',
      'title',
      'company_name',
      'full_name',
    ];
    for (const col of nameCols) {
      if (
        row[col] &&
        typeof row[col] === 'string' &&
        row[col].trim() &&
        row[col].trim() !== id
      ) {
        descriptor = row[col].trim();
        break;
      }
    }

    if (!descriptor) {
      for (const [k, v] of Object.entries(row)) {
        const lower = k.toLowerCase();
        if (
          k !== idInfo.column &&
          /(?:name|title)$/i.test(lower) &&
          v &&
          typeof v === 'string' &&
          v.trim() &&
          v.trim() !== id
        ) {
          descriptor = v.trim();
          break;
        }
      }
    }

    if (descriptor) {
      return `${id} (${descriptor})`;
    }
    return id;
  });

  const moreSuffix = count > 5 ? `, and ${count - 5} more` : '';
  const recordList = descriptors.join(', ') + moreSuffix;

  return `Found ${count} matching record(s) in ${displayTable}: ${recordList}.`;
}

/**
 * Summarizes verified SQL rows deterministically in 0ms (Option-A format),
 * eliminating redundant sequential LLM calls while maintaining full understandability.
 */
async function summarizeQueryRowsWithAi(params) {
  return buildDeterministicQuerySummary(params);
}

/**
 * Attempts to satisfy a basic single-table read query directly without entering the
 * multi-table + document RAG B2B pipeline. Returns `null` when normal routing should run.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.prompt
 * @param {string | null} [params.entity]
 * @param {Array<object>} [params.history]
 * @returns {Promise<object | null>}
 */
async function tryExecuteFastTableQuery({
  businessId,
  prompt,
  entity = null,
  history = [],
}) {
  if (hasCustomWorkspaceGeminiGenerator()) {
    return null;
  }
  const normalizedHistory = normalizeConversationHistory(history);
  if (!isBasicTableQueryCandidate(prompt, normalizedHistory)) {
    return null;
  }

  const metadataRows = await listWorkspaceTableMetadataCached(businessId);
  if (!Array.isArray(metadataRows) || metadataRows.length === 0) {
    return null;
  }

  const targetMatch = resolveSingleTableTarget(
    prompt,
    entity,
    metadataRows,
    normalizedHistory
  );
  if (!targetMatch?.meta) {
    return null;
  }

  const meta = targetMatch.meta;
  const tableName = meta.table_name;
  const hasCategoricalProfiles =
    Array.isArray(meta?.columns_profile) &&
    meta.columns_profile.some((c) => Array.isArray(c.categorical_values) && c.categorical_values.length > 0);

  const schema = await discoverTableSchema(tableName, businessId, {
    useCache: true,
    prefetchedMetadata: meta,
    skipSampleQuery: hasCategoricalProfiles,
  });

  const interpreted = await interpretNaturalLanguageQuery({
    entity: schema.entity,
    schema,
    message: prompt.trim(),
    isMutation: false,
    businessId,
    skipCatalogLoad: true,
    compactPrompt: true,
    conversationHistory: normalizedHistory,
  });

  if (!interpreted || interpreted.status === 'clarification_needed') {
    const clarifyMsg =
      interpreted?.message ||
      `I could not map that query clearly onto columns in ${tableName}. Please clarify your filter criteria.`;
    return {
      status: 'SHEET_QUERY',
      intent: 'sheet_query',
      entity: schema.entity,
      prompt,
      message: clarifyMsg,
      answer: clarifyMsg,
      count: 0,
      rows: [],
      highlighted_rows: [],
      interpretedQuery: null,
      fast_path: true,
      citations: [],
    };
  }

  const execution = await executeSpreadsheetQuery({
    entity: schema.entity,
    schema,
    businessId,
    queryJson: interpreted,
    skipEnsure: true,
    sourcePrompt: prompt.trim(),
    conversationHistory: normalizedHistory,
  });

  if (execution.status === 'clarification_needed') {
    const clarifyMsg =
      execution.message || `Please clarify your filter criteria for ${schema.entity}.`;
    return {
      status: 'SHEET_QUERY',
      intent: 'sheet_query',
      entity: schema.entity,
      prompt,
      message: clarifyMsg,
      answer: clarifyMsg,
      count: 0,
      rows: [],
      highlighted_rows: [],
      interpretedQuery: null,
      fast_path: true,
      citations: [],
    };
  }

  const rows = Array.isArray(execution.rows) ? execution.rows : [];
  const answer = await summarizeQueryRowsWithAi({
    prompt: prompt.trim(),
    tableName: schema.tableName,
    interpreted,
    rows,
    schema,
    emailColumn: meta.email_column || null,
  });

  const highlightedRows = buildHighlightedRows(schema.tableName, rows);

  return {
    status: 'SHEET_QUERY',
    intent: 'sheet_query',
    entity: schema.entity,
    prompt,
    message: answer,
    answer,
    count: rows.length,
    rows,
    matched_ids: highlightedRows.map((h) => h.row_identifier),
    highlighted_rows: highlightedRows,
    interpretedQuery: execution.interpretedQuery,
    fast_path: true,
    citations: rows.slice(0, 8).map((row, idx) =>
      buildTableRowCitation(schema.tableName, row, idx + 1)
    ),
  };
}

/**
 * Returns a table-local mutation route before the workspace RAG intent model.
 * The caller still sends the request to the ordinary sheet mutation endpoint,
 * where Gemini interpretation, validation, preview, and user confirmation apply.
 */
async function tryRouteBasicTableMutation({
  businessId,
  prompt,
  entity = null,
  history = [],
}) {
  if (
    hasCustomWorkspaceGeminiGenerator() ||
    !isBasicTableMutationCandidate(prompt, history)
  ) {
    return null;
  }

  const metadataRows = await listWorkspaceTableMetadataCached(businessId);
  if (!Array.isArray(metadataRows) || metadataRows.length === 0) return null;

  const targetMatch = resolveSingleTableTarget(
    prompt,
    entity,
    metadataRows,
    []
  );
  if (!targetMatch?.meta) return null;

  return {
    status: 'SHEET_MUTATION',
    intent: 'sheet_mutation',
    entity: targetMatch.meta.table_name,
    prompt,
    message: 'Preparing a validated spreadsheet mutation preview.',
    fast_path: true,
    citations: [],
  };
}

module.exports = {
  isBasicTableQueryCandidate,
  isBasicTableMutationCandidate,
  resolveSingleTableTarget,
  buildDeterministicQuerySummary,
  summarizeQueryRowsWithAi,
  buildHighlightedRows,
  tryExecuteFastTableQuery,
  tryRouteBasicTableMutation,
};
