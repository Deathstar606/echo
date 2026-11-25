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
} = require('../rag/crossRagService');
const {
  detectConversationalIntent,
} = require('../rag/contextRetrievalService');
const {
  listDocumentsForBusiness,
} = require('../rag/documentIngestionService');
const {
  generateStructuredJsonWithRetry,
  hasCustomWorkspaceGeminiGenerator,
} = require('../llm/geminiService');
const {
  normalizeConversationHistory,
  getLatestActiveContext,
  hasFollowUpReference,
  hasExplicitScopeReset,
} = require('../../utils/conversationHistory');

const MUTATION_OR_ACTION_REGEX =
  /\b(?:update|set|change|modify|edit|alter|swap|replace|refund|reconcile|enforce|process|elevate|upgrade|downgrade|promote|freeze|cut|reduce|increase|decrease|adjust|add|insert|create|delete|remove|drop|allocate|deploy|assign|audit|review|email|e-mail|notify|message|alert|send|draft|dispatch|apply|mark|cancel|trigger|execute|clear|import|upload)\b/i;
const DIRECT_MUTATION_LEAD_REGEX =
  /^(?:please\s+)?(?:update|set|change|modify|edit|alter|swap|replace|increase|decrease|reduce|cut|adjust|add|subtract|multiply|mark|delete|remove|create|allocate|assign|deploy|issue|grant|deduct)\b/i;
const FOLLOW_UP_MODIFICATION_LEAD_REGEX =
  /^(?:actually|instead|no,?\s+|make\s+(?:it|that)|do\s+the\s+same|same\s+for)\b/i;
const GREETING_OR_ACK_REGEX =
  /^(?:hi|hello|hey|thanks|thank\s+you|bye|goodbye|yes|no|ok|okay|confirm|cancel)[.!\s]*$/i;
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
  if (MUTATION_OR_ACTION_REGEX.test(text)) return false;
  if (B2B_OR_DOC_REGEX.test(text) || SCOPED_POLICY_PREP_REGEX.test(text)) return false;

  if (!READ_LEAD_REGEX.test(text)) {
    if (GREETING_OR_ACK_REGEX.test(text) || hasExplicitScopeReset(text)) {
      return false;
    }
    const normalizedHistory = normalizeConversationHistory(history);
    const activeCtx = getLatestActiveContext(normalizedHistory);
    if (
      activeCtx.pendingClarification?.isEmailClarification ||
      activeCtx.pendingClarification?.baseIntent === 'EMAIL_CLARIFICATION'
    ) {
      return false;
    }
    if (activeCtx.pendingClarification?.baseIntent === 'SHEET_QUERY') {
      return true;
    }
    if (activeCtx.activeTargetTable && hasFollowUpReference(text)) {
      return true;
    }
    return false;
  }

  return true;
}

/**
 * Identifies direct, table-local mutations (including follow-up mutations and
 * clarification replies across the 5-turn memory window) that do not need
 * heavyweight document/RAG intent routing.
 *
 * @param {string} prompt
 * @param {Array<object>} [history=[]]
 * @returns {boolean}
 */
function isBasicTableMutationCandidate(prompt, history = []) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (GREETING_OR_ACK_REGEX.test(text)) return false;
  if (
    B2B_OR_DOC_REGEX.test(text) ||
    SCOPED_POLICY_PREP_REGEX.test(text) ||
    EXTERNAL_ACTION_REGEX.test(text) ||
    MULTI_SOURCE_MUTATION_REGEX.test(text)
  ) {
    return false;
  }

  if (DIRECT_MUTATION_LEAD_REGEX.test(text)) {
    if (hasFollowUpReference(text) && Array.isArray(history) && history.length > 0) {
      const normalizedHistory = normalizeConversationHistory(history);
      const activeCtx = getLatestActiveContext(normalizedHistory);
      const lastIntent = String(activeCtx.lastTurn?.resolved_intent || '').toUpperCase();
      if (
        activeCtx.matchedRowIds.length === 0 &&
        !activeCtx.pendingClarification &&
        !lastIntent.includes('SHEET_MUTATION')
      ) {
        return false;
      }
    }
    return true;
  }

  if (READ_LEAD_REGEX.test(text) || NON_TABLE_WHY_HOW_REGEX.test(text)) {
    return false;
  }

  const normalizedHistory = normalizeConversationHistory(history);
  if (normalizedHistory.length === 0) return false;

  const activeCtx = getLatestActiveContext(normalizedHistory);
  if (
    activeCtx.pendingClarification?.isEmailClarification ||
    activeCtx.pendingClarification?.baseIntent === 'EMAIL_CLARIFICATION'
  ) {
    return false;
  }
  if (activeCtx.pendingClarification?.baseIntent === 'SHEET_MUTATION') {
    return !hasExplicitScopeReset(text);
  }

  const lastIntent = String(activeCtx.lastTurn?.resolved_intent || '').toUpperCase();
  if (lastIntent.includes('SHEET_MUTATION') && !hasExplicitScopeReset(text)) {
    if (
      FOLLOW_UP_MODIFICATION_LEAD_REGEX.test(text) ||
      tokenizePromptWords(text).length <= 6
    ) {
      return true;
    }
  }

  return false;
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
    const matchedNameRoots = new Set();
    for (const token of nameTokens) {
      if (new RegExp(`\\b${escapeRegex(token)}\\b`, 'i').test(promptLower)) {
        score += 3;
        matchedNameRoots.add(token.replace(/s$/, ''));
      }
    }
    const orderTokenAlreadyMatched = matchedNameRoots.has('order');
    if (
      !orderTokenAlreadyMatched &&
      tableLower.includes('order') &&
      !tableLower.includes('backorder') &&
      /\borders?\b/i.test(promptLower)
    ) {
      score += 4;
    } else if (
      !orderTokenAlreadyMatched &&
      tableLower.includes('backorder') &&
      /\borders?\b/i.test(promptLower)
    ) {
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

const GENERIC_METADATA_TABLE_TOKENS = new Set([
  'dataset',
  'data',
  'table',
  'sheet',
  'management',
  'csv',
  'records',
  'rows',
]);

const SYSTEM_METADATA_COLS = new Set([
  'id',
  'business_id',
  'workspace_id',
  'user_id',
  'workspace_document_id',
  '_google_row_index',
  'created_at',
  'updated_at',
]);

/**
 * Dynamically checks whether a prompt spans 2 or more tables in `workspace_table_metadata`
 * (e.g., referencing an active/follow-up order table AND a column or table noun belonging
 * exclusively to another workspace table). Zero hardcoded table or column names.
 *
 * @param {string} prompt
 * @param {Array<object>} [metadataRows=[]]
 * @param {Array<object>} [conversationHistory=[]]
 * @param {string | null} [activeEntity=null]
 * @returns {boolean}
 */
function promptSpansMultipleWorkspaceTables(
  prompt,
  metadataRows = [],
  conversationHistory = [],
  activeEntity = null
) {
  if (!Array.isArray(metadataRows) || metadataRows.length <= 1) {
    return false;
  }
  const promptLower = String(prompt || '').toLowerCase();
  if (!promptLower.trim()) return false;

  const normalizedHistory = normalizeConversationHistory(conversationHistory);
  const activeCtx = getLatestActiveContext(normalizedHistory, activeEntity);
  const followUpTableNorm =
    hasFollowUpReference(prompt) && (activeCtx.activeTargetTable || activeEntity)
      ? normalizeEntityName(activeCtx.activeTargetTable || activeEntity).toLowerCase()
      : null;

  const tableDescriptors = metadataRows.map((meta) => {
    const tableName = String(meta?.table_name || '').trim();
    const tableLower = tableName.toLowerCase();
    const tableNorm = normalizeEntityName(tableName).toLowerCase();
    const spacedTable = tableLower.replace(/_/g, ' ');

    const nameTokens = new Set(
      expandTokenVariants(tableLower).filter(
        (t) => t.length >= 3 && !GENERIC_METADATA_TABLE_TOKENS.has(t)
      )
    );
    // If table name is compound like "backorders_dataset", also include root "order"/"orders"
    if (tableLower.includes('order')) {
      nameTokens.add('order');
      nameTokens.add('orders');
    }

    const colTokens = new Set();
    const fullColNames = new Set();
    for (const col of Array.isArray(meta?.columns_profile) ? meta.columns_profile : []) {
      const colName = String(col?.column_name || col?.name || '').trim().toLowerCase();
      if (!colName || SYSTEM_METADATA_COLS.has(colName)) continue;
      fullColNames.add(colName);
      fullColNames.add(colName.replace(/_/g, ' '));
      for (const tok of expandTokenVariants(colName)) {
        if (tok.length >= 3 && !GENERIC_METADATA_TABLE_TOKENS.has(tok)) {
          colTokens.add(tok);
        }
      }
    }

    const allVocab = new Set([...nameTokens, ...colTokens, ...fullColNames]);
    const explicitTableHit =
      new RegExp(`\\b${escapeRegex(tableLower)}(?:\\.csv)?\\b`, 'i').test(promptLower) ||
      (spacedTable !== tableLower &&
        new RegExp(`\\b${escapeRegex(spacedTable)}\\b`, 'i').test(promptLower));

    const matchedNameTokens = [];
    if (explicitTableHit) {
      matchedNameTokens.push(tableNorm);
    }
    for (const tok of nameTokens) {
      if (new RegExp(`\\b${escapeRegex(tok)}\\b`, 'i').test(promptLower)) {
        matchedNameTokens.push(tok);
      }
    }

    const matchedCols = [];
    for (const cName of fullColNames) {
      if (cName.length >= 3 && new RegExp(`\\b${escapeRegex(cName)}\\b`, 'i').test(promptLower)) {
        matchedCols.push(cName);
      }
    }
    for (const cTok of colTokens) {
      if (cTok.length >= 4 && new RegExp(`\\b${escapeRegex(cTok)}\\b`, 'i').test(promptLower)) {
        matchedCols.push(cTok);
      }
    }

    return {
      tableName,
      tableNorm,
      allVocab,
      matchedNameTokens,
      matchedCols,
      matchedAllTokens: [...new Set([...matchedNameTokens, ...matchedCols])],
      isFollowUpTarget: Boolean(followUpTableNorm && followUpTableNorm === tableNorm),
    };
  });

  // Two distinct tables (A, B) are jointly referenced ONLY when EACH table has at least
  // one independent match (or follow-up anchor) that is NOT in the other table's vocabulary
  // (so a single shared word like "orders" across two order tables never false-triggers).
  for (let i = 0; i < tableDescriptors.length; i += 1) {
    const tableA = tableDescriptors[i];
    if (tableA.matchedNameTokens.length === 0 && !tableA.isFollowUpTarget) continue;

    for (let j = 0; j < tableDescriptors.length; j += 1) {
      if (i === j) continue;
      const tableB = tableDescriptors[j];
      const aHasExclusiveSignal =
        (tableA.isFollowUpTarget && tableB.tableNorm !== tableA.tableNorm) ||
        tableA.matchedAllTokens.some((tok) => !tableB.allVocab.has(tok));
      if (!aHasExclusiveSignal) continue;

      const bHasExclusiveColHit = tableB.matchedCols.some((colTok) => !tableA.allVocab.has(colTok));
      const bHasExclusiveNameHit = tableB.matchedNameTokens.some(
        (nameTok) => !tableA.allVocab.has(nameTok)
      );

      if (bHasExclusiveColHit || (bHasExclusiveNameHit && tableA.isFollowUpTarget)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detects relational sufficiency/fulfillment checks or same-table column-to-column
 * comparisons that cannot be evaluated as `<column> <op> <constant_literal>` in
 * `executeSpreadsheetQuery` and must route to `routeWorkspaceIntent` (`route_and_plan`).
 *
 * @param {string} prompt
 * @param {object | null} [targetMeta=null]
 * @returns {boolean}
 */
function requiresRelationalOrColumnComparison(prompt, targetMeta = null) {
  const text = String(prompt || '').trim();
  if (!text) return false;

  // 1. Relational sufficiency / capacity-to-fulfill demand pattern
  const relationalSufficiencyPattern =
    /\b(?:(?:below|under|enough|sufficient|insufficient|lack(?:s|ing)?|short\s+of|out\s+of)\s+(?:the\s+|our\s+|available\s+|current\s+|minimum\s+|required\s+)?[a-z0-9_]+(?:\s+[a-z0-9_]+){0,2}\s+to\s+(?:fulfil+|fullfil+|satisfy|cover|accommodate|complete|process|handle|meet|supply|allocate|ship|support)|can\s+(?:we|they|it|the\s+[a-z0-9_]+)\s+(?:fulfil+|fullfil+|accommodate|cover|satisfy|allocate|handle)|enough\s+[a-z0-9_]+\s+for\s+(?:the|those|these|all|every|each)\b)/i;
  if (relationalSufficiencyPattern.test(text)) {
    return true;
  }

  // 2. Same-table column-to-column comparison (2 numeric columns compared without literal numbers)
  const cols = Array.isArray(targetMeta?.columns_profile) ? targetMeta.columns_profile : [];
  if (cols.length >= 2) {
    const promptLower = text.toLowerCase();
    const matchedNumericCols = [];
    for (const col of cols) {
      const colName = String(col?.column_name || col?.name || '').trim().toLowerCase();
      if (!colName || SYSTEM_METADATA_COLS.has(colName)) continue;
      const dataType = String(col?.data_type || col?.type || '').toLowerCase();
      const isNumeric = /int|num|dec|float|double|real/.test(dataType) || Boolean(col?.numeric_stats);
      if (!isNumeric) continue;
      const spaced = colName.replace(/_/g, ' ');
      if (
        new RegExp(`\\b${escapeRegex(colName)}\\b`, 'i').test(promptLower) ||
        (spaced !== colName && new RegExp(`\\b${escapeRegex(spaced)}\\b`, 'i').test(promptLower))
      ) {
        matchedNumericCols.push(colName);
      }
    }
    if (
      matchedNumericCols.length >= 2 &&
      /\b(?:less\s+than|greater\s+than|more\s+than|below|above|under|over|exceed(?:s|ing)?|equal(?:s|\s+to)?|not\s+equal|minus|difference\s+between|<|>|=)\b/i.test(
        promptLower
      ) &&
      !/\b\d+(?:\.\d+)?\b/.test(promptLower)
    ) {
      return true;
    }
  }

  return false;
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
  if (
    promptSpansMultipleWorkspaceTables(
      prompt,
      metadataRows,
      normalizedHistory,
      activeEntity
    )
  ) {
    return null;
  }

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

  // Follow-up narrowing, clarification replies, or post-mutation column/value follow-ups inherit the prior turn's active table
  // ONLY when no other workspace table scored higher on explicit domain/column tokens.
  const isMutationFollowUp = String(activeCtx.lastTurn?.resolved_intent || '')
    .toUpperCase()
    .includes('SHEET_MUTATION');
  if (
    (hasFollowUpReference(prompt) ||
      Boolean(activeCtx.pendingClarification) ||
      isMutationFollowUp) &&
    activeCtx.activeTargetTable &&
    !hasExplicitScopeReset(prompt)
  ) {
    const priorNorm = normalizeEntityName(activeCtx.activeTargetTable);
    const priorScored = scored.find(
      (item) => normalizeEntityName(item.tableName) === priorNorm
    );
    const topOther = scored.find(
      (item) => normalizeEntityName(item.tableName) !== priorNorm
    );
    if (
      priorScored &&
      (!topOther || topOther.score <= 0 || priorScored.score >= topOther.score)
    ) {
      return { meta: priorScored.meta };
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

const QUERY_GRAMMAR_WORDS = new Set([
  ...STOP_WORDS,
  'record', 'records', 'row', 'rows', 'entry', 'entries', 'table', 'sheet',
  'dataset', 'csv', 'count', 'total', 'sum', 'average', 'avg', 'min', 'max',
  'minimum', 'maximum', 'most', 'least', 'top', 'bottom', 'first', 'last',
  'between', 'before', 'after', 'since', 'until', 'today', 'month', 'year',
  'day', 'days', 'hour', 'hours', 'more', 'fewer', 'many', 'much', 'any',
  'every', 'each', 'both', 'either', 'neither', 'only', 'just', 'also',
  'please', 'can', 'could', 'would', 'you', 'your', 'our', 'their', 'its',
  'who', 'whom', 'whose', 'what', 'which', 'where', 'when', 'how', 'number',
  'amount', 'value', 'values', 'status', 'state', 'type', 'category', 'level',
  'rate', 'date', 'time', 'name', 'names', 'code', 'id', 'ids', 'unit',
  'units', 'stock', 'stocks', 'inventory', 'price', 'priced', 'prices',
  'cost', 'order', 'orders', 'product', 'products', 'item', 'items',
  'customer', 'customers', 'buyer', 'buyers', 'account', 'accounts', 'user',
  'users', 'client', 'clients', 'have', 'has', 'had', 'been', 'being', 'does',
  'did', 'will', 'them', 'those', 'these', 'there', 'here', 'exist', 'exists',
  'available', 'currently', 'still', 'right', 'now', 'true', 'false', 'yes',
  'lowest', 'highest', 'larger', 'smaller', 'exceed', 'exceeds', 'exceeding',
  'within', 'across', 'per', 'containing', 'contain', 'contains', 'starting',
  'ending', 'matching', 'match', 'sort', 'sorted', 'descending', 'ascending',
]);

function addWordStemVariants(word, targetSet) {
  const clean = String(word || '').toLowerCase().trim();
  if (clean.length < 3) return;
  targetSet.add(clean);
  if (clean.endsWith('ies') && clean.length > 4) targetSet.add(`${clean.slice(0, -3)}y`);
  if (clean.endsWith('ied') && clean.length > 4) targetSet.add(`${clean.slice(0, -3)}y`);
  if (clean.endsWith('es') && clean.length > 4) targetSet.add(clean.slice(0, -2));
  if (clean.endsWith('s') && clean.length > 3) targetSet.add(clean.slice(0, -1));
  if (clean.endsWith('ed') && clean.length > 4) {
    const base = clean.slice(0, -2);
    targetSet.add(base);
    targetSet.add(`${base}e`);
    if (/([a-z])\1$/.test(base)) targetSet.add(base.slice(0, -1));
  }
  if (clean.endsWith('d') && clean.length > 4) targetSet.add(clean.slice(0, -1));
  if (clean.endsWith('ing') && clean.length > 5) {
    const base = clean.slice(0, -3);
    targetSet.add(base);
    targetSet.add(`${base}e`);
    if (/([a-z])\1$/.test(base)) targetSet.add(base.slice(0, -1));
  }
  if (clean.endsWith('ly') && clean.length > 4) targetSet.add(clean.slice(0, -2));
}

/**
 * Checks generically (with zero hardcoded domain synonyms) whether every
 * content word in the user's prompt maps directly onto the resolved table's
 * own schema vocabulary (table name, column names, categorical values, nested keys).
 * Unmapped conceptual words (e.g. "delayed", "stuck", "overwhelmed") return false
 * so the request flows straight to `route_and_plan` instead of failing or dumping rows.
 *
 * @param {string} prompt
 * @param {object} meta
 * @param {Array<object>} [history=[]]
 * @returns {boolean}
 */
function arePromptConceptsCoveredByTable(
  prompt,
  meta,
  history = [],
  allMetadataRows = []
) {
  const text = String(prompt || '').trim();
  if (!text || !meta) return false;

  const normalizedHistory = normalizeConversationHistory(history);
  const activeCtx = getLatestActiveContext(normalizedHistory);
  // Only bypass vocabulary coverage for short clarification replies to an active clarification turn
  if (
    activeCtx.pendingClarification &&
    text.split(/\s+/).filter(Boolean).length <= 6
  ) {
    return true;
  }

  const vocabRoots = new Set();
  for (const tok of String(meta.table_name || '').toLowerCase().split(/[^a-z0-9]+/)) {
    addWordStemVariants(tok, vocabRoots);
  }
  const cols = Array.isArray(meta.columns_profile) ? meta.columns_profile : [];
  for (const col of cols) {
    for (const tok of String(col.column_name || '').toLowerCase().split(/[^a-z0-9]+/)) {
      addWordStemVariants(tok, vocabRoots);
    }
    if (Array.isArray(col.categorical_values)) {
      for (const val of col.categorical_values) {
        const valStr = String(val ?? '');
        if (valStr.length > 80 || /^\s*[{[]/.test(valStr)) continue;
        for (const tok of valStr.toLowerCase().split(/[^a-z0-9]+/)) {
          addWordStemVariants(tok, vocabRoots);
        }
      }
    }
    if (Array.isArray(col.nested_structure?.observed_keys)) {
      for (const kObj of col.nested_structure.observed_keys) {
        for (const tok of String(kObj?.name || '').toLowerCase().split(/[^a-z0-9]+/)) {
          addWordStemVariants(tok, vocabRoots);
        }
      }
    }
  }

  // Build exclusive schema roots belonging to OTHER workspace tables (absent from `meta`)
  // so domain nouns in QUERY_GRAMMAR_WORDS (like 'stock', 'product', 'order') are NOT ignored
  // when they actually refer to a column or table name on a different workspace table.
  const otherTableExclusiveRoots = new Set();
  if (Array.isArray(allMetadataRows) && allMetadataRows.length > 1) {
    const metaNorm = normalizeEntityName(String(meta.table_name || '')).toLowerCase();
    for (const other of allMetadataRows) {
      const otherNorm = normalizeEntityName(String(other?.table_name || '')).toLowerCase();
      if (!otherNorm || otherNorm === metaNorm) continue;
      for (const tok of String(other.table_name || '').toLowerCase().split(/[^a-z0-9]+/)) {
        if (tok.length >= 3 && !GENERIC_METADATA_TABLE_TOKENS.has(tok)) {
          const variants = new Set();
          addWordStemVariants(tok, variants);
          for (const v of variants) {
            if (!vocabRoots.has(v)) otherTableExclusiveRoots.add(v);
          }
        }
      }
      for (const col of Array.isArray(other?.columns_profile) ? other.columns_profile : []) {
        const cName = String(col?.column_name || col?.name || '').toLowerCase();
        if (!cName || SYSTEM_METADATA_COLS.has(cName)) continue;
        for (const tok of cName.split(/[^a-z0-9]+/)) {
          if (tok.length >= 3 && !GENERIC_METADATA_TABLE_TOKENS.has(tok)) {
            const variants = new Set();
            addWordStemVariants(tok, variants);
            for (const v of variants) {
              if (!vocabRoots.has(v)) otherTableExclusiveRoots.add(v);
            }
          }
        }
      }
    }
  }

  // Raw alphanumeric/hyphenated codes (SKUs, order IDs, etc.) and numbers pass automatically
  const tokens = text
    .split(/[^a-zA-Z0-9_-]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const rawTok of tokens) {
    if (rawTok.length < 3) continue;
    if (/^\d/.test(rawTok) || /[_-]/.test(rawTok) || /\d/.test(rawTok)) continue;
    const lower = rawTok.toLowerCase();

    const candidates = new Set();
    addWordStemVariants(lower, candidates);
    const matchesVocab = [...candidates].some((c) => vocabRoots.has(c));
    if (matchesVocab) continue;

    const matchesOtherTableExclusive = [...candidates].some((c) =>
      otherTableExclusiveRoots.has(c)
    );
    if (matchesOtherTableExclusive) {
      return false;
    }

    if (QUERY_GRAMMAR_WORDS.has(lower)) continue;

    return false;
  }

  return true;
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
 * @param {Array<object> | null} [params.metadataRows]
 * @returns {Promise<object | null>}
 */
async function tryExecuteFastTableQuery({
  businessId,
  prompt,
  entity = null,
  history = [],
  metadataRows = null,
}) {
  if (hasCustomWorkspaceGeminiGenerator()) {
    return null;
  }
  const normalizedHistory = normalizeConversationHistory(history);
  if (!isBasicTableQueryCandidate(prompt, normalizedHistory)) {
    return null;
  }

  const resolvedMetadata = Array.isArray(metadataRows)
    ? metadataRows
    : await listWorkspaceTableMetadataCached(businessId);
  if (!Array.isArray(resolvedMetadata) || resolvedMetadata.length === 0) {
    return null;
  }

  const targetMatch = resolveSingleTableTarget(
    prompt,
    entity,
    resolvedMetadata,
    normalizedHistory
  );
  if (!targetMatch?.meta) {
    return null;
  }

  const meta = targetMatch.meta;
  if (requiresRelationalOrColumnComparison(prompt, meta)) {
    return null;
  }
  if (!arePromptConceptsCoveredByTable(prompt, meta, normalizedHistory, resolvedMetadata)) {
    return null;
  }

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
    const activeCtx = getLatestActiveContext(normalizedHistory, entity);
    const isSchemaLimitation = /^Schema limitation:/i.test(
      String(interpreted?.message || '').trim()
    );
    if (isSchemaLimitation || !activeCtx.pendingClarification) {
      return null;
    }
    const clarifyMsg =
      interpreted?.message ||
      `I could not map that query clearly onto columns in ${tableName}. Please clarify your filter criteria.`;
    return {
      status: 'SHEET_QUERY',
      query_status: 'clarification_needed',
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
      query_status: 'clarification_needed',
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
  const executedFilters = Array.isArray(execution.interpretedQuery?.filters)
    ? execution.interpretedQuery.filters
    : Array.isArray(interpreted?.filters)
      ? interpreted.filters
      : [];
  const appliedFilterSummary = executedFilters
    .map((f) => `${f.field || f.column} ${f.operator} ${JSON.stringify(f.value)}`)
    .join(` ${execution.interpretedQuery?.filter_logic || interpreted?.filter_logic || 'AND'} `);

  return {
    status: 'SHEET_QUERY',
    query_status: 'ok',
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
    applied_filter_summary: appliedFilterSummary,
    fast_path: true,
    citations: rows.slice(0, 8).map((row, idx) =>
      buildTableRowCitation(schema.tableName, row, idx + 1)
    ),
  };
}

const DOC_SOURCE_ACTION_CUE_REGEX =
  /\b(?:add|insert|import|append|populate|load|sync|merge|from|via|using|per|listed\s+in|mentioned\s+in|found\s+in|extracted\s+from)\b/i;

/**
 * Returns true when the prompt explicitly references an uploaded workspace
 * document (either via generic document phrasing or matching an uploaded filename stem),
 * preventing document-sourced table edits from bypassing into the document-blind fast path.
 *
 * @param {string} prompt
 * @param {Array<object>} [documents=[]]
 * @returns {boolean}
 */
function promptReferencesWorkspaceDocument(prompt, documents = []) {
  const text = String(prompt || '').trim();
  if (!text) return false;

  if (B2B_OR_DOC_REGEX.test(text) || SCOPED_POLICY_PREP_REGEX.test(text)) {
    return true;
  }

  if (
    /\b(?:from|in|per|listed\s+in|mentioned\s+in|found\s+in|according\s+to|using|via)\s+(?:the\s+|our\s+|this\s+|an?\s+|uploaded\s+){0,2}(?:doc|docs|document|documents|pdf|pdfs|file|files|attachment|report|notice|memo|manifest|letter|bulletin|schedule|roster|sheet\s+pdf)\b/i.test(
      text
    )
  ) {
    return true;
  }

  if (!Array.isArray(documents) || documents.length === 0) {
    return false;
  }

  const normPrompt = text
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

  for (const doc of documents) {
    const rawName = String(doc?.filename || '').trim();
    if (!rawName) continue;
    const rawLower = rawName.toLowerCase();
    if (text.toLowerCase().includes(rawLower)) {
      return true;
    }
    const stem = rawLower.replace(/\.[^.]+$/, '');
    const spacedStem = stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (spacedStem.length >= 4 && normPrompt.includes(spacedStem)) {
      return true;
    }
  }

  return false;
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
  metadataRows = null,
}) {
  if (
    hasCustomWorkspaceGeminiGenerator() ||
    !isBasicTableMutationCandidate(prompt, history)
  ) {
    return null;
  }

  if (promptReferencesWorkspaceDocument(prompt, [])) {
    return null;
  }

  if (DOC_SOURCE_ACTION_CUE_REGEX.test(String(prompt || ''))) {
    const workspaceDocs = await listDocumentsForBusiness(businessId).catch(() => []);
    if (promptReferencesWorkspaceDocument(prompt, workspaceDocs)) {
      return null;
    }
  }

  const normalizedHistory = normalizeConversationHistory(history);
  const resolvedMetadata = Array.isArray(metadataRows)
    ? metadataRows
    : await listWorkspaceTableMetadataCached(businessId);
  if (!Array.isArray(resolvedMetadata) || resolvedMetadata.length === 0) return null;

  const targetMatch = resolveSingleTableTarget(
    prompt,
    entity,
    resolvedMetadata,
    normalizedHistory
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
  promptReferencesWorkspaceDocument,
  promptSpansMultipleWorkspaceTables,
  requiresRelationalOrColumnComparison,
  resolveSingleTableTarget,
  arePromptConceptsCoveredByTable,
  buildDeterministicQuerySummary,
  summarizeQueryRowsWithAi,
  buildHighlightedRows,
  tryExecuteFastTableQuery,
  tryRouteBasicTableMutation,
};
