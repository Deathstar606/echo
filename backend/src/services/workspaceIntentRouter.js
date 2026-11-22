const {
  generateStructuredJsonWithRetry,
  hasCustomWorkspaceGeminiGenerator,
} = require('./geminiService');
const {
  discoverWorkspaceSources,
} = require('./queryRouterService');
const {
  retrieveHybridDocumentChunks,
} = require('./crossRagService');
const {
  detectConversationalIntent,
} = require('./contextRetrievalService');
const {
  normalizeEntityName,
} = require('./sheetSchemaService');
const {
  normalizeConversationHistory,
  getLatestActiveContext,
  formatConversationHistoryForPrompt,
} = require('../utils/conversationHistory');
const {
  serializeTableForPrompt,
  SCHEMA_TRUTH_PRECEDENCE_RULE,
} = require('../utils/schemaPromptSerializer');
const { READ_PLAN_SCHEMA, validateReadPlan } = require('./workspaceReadService');
const AppError = require('../utils/AppError');

const WORKSPACE_INTENTS = new Set([
  'sheet_query',
  'cross_source_read',
  'sheet_mutation',
  'document_table_sync',
  'cross_document_operation',
  'document_question',
  'conversation',
  'clarification_needed',
]);

const WORKSPACE_INTENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: {
      type: 'STRING',
      enum: [...WORKSPACE_INTENTS],
    },
    entity: {
      type: 'STRING',
      description: 'Primary exact table name from ACTIVE BUSINESS SOURCES, if needed',
    },
    target_entities: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'All exact table names from ACTIVE BUSINESS SOURCES involved in the request (include multiple table names ONLY when the user instruction explicitly asks to inspect or update more than one table).',
    },
    document_grounded: {
      type: 'BOOLEAN',
      description:
        'True ONLY when uploaded document excerpts contain rules, thresholds, batch/SKU lists, or policy definitions required to answer or explain the request.',
    },
    interpretation_note: {
      type: 'STRING',
      description:
        'When the user prompt uses conceptual, colloquial, or status-adjacent terms that do not match an exact column name, state a concise 1-sentence explanation of how those terms map to the queried column(s) and enum values.',
    },
    table_queries: {
      ...READ_PLAN_SCHEMA.properties.table_queries,
      description:
        'REQUIRED non-empty parameterized query plan whenever intent is sheet_query or cross_source_read; return [] for other intents.',
    },
    dependent_lookups: {
      ...READ_PLAN_SCHEMA.properties.dependent_lookups,
      description:
        'Optional two-stage anchor-to-lookup table joins when cross-checking or comparing rows across two or more tables in sheet_query or cross_source_read; return [] otherwise.',
    },
    cross_table_comparisons: {
      ...READ_PLAN_SCHEMA.properties.cross_table_comparisons,
      description:
        'Optional deterministic cross-table arithmetic and threshold filters between anchor and lookup tables in cross_source_read; return [] otherwise.',
    },
    answer: {
      type: 'STRING',
      description: 'A concise grounded reply for conversational or document questions',
    },
    clarification: {
      type: 'STRING',
      description: 'What needs clarification when intent or target is genuinely ambiguous',
    },
  },
  required: ['intent', 'document_grounded', 'table_queries'],
};

function formatWorkspaceSources(tables, documents, chunks) {
  const tableContext = tables.map((tableEntry) =>
    serializeTableForPrompt(tableEntry, { includeMutability: true })
  );
  const documentContext = documents.map((document) => ({
    filename: document.filename,
    page_count: document.page_count,
  }));
  const positiveChunks = (chunks || []).filter((c) => Number(c.hybrid_score) > 0);
  const chunkPool = positiveChunks.length > 0 ? positiveChunks : chunks || [];
  // Round-robin across distinct documents by score so a single verbose manifest/PDF
  // cannot crowd out policy/governance clauses in another workspace document.
  const chunksByDoc = new Map();
  for (const chunk of chunkPool) {
    const docKey = String(chunk?.filename || 'doc').toLowerCase();
    if (!chunksByDoc.has(docKey)) chunksByDoc.set(docKey, []);
    chunksByDoc.get(docKey).push(chunk);
  }
  const diverseChunks = [];
  const docQueues = [...chunksByDoc.values()];
  let round = 0;
  while (diverseChunks.length < 6) {
    let addedInRound = false;
    for (const queue of docQueues) {
      if (round < queue.length && diverseChunks.length < 6) {
        diverseChunks.push(queue[round]);
        addedInRound = true;
      }
    }
    if (!addedInRound) break;
    round += 1;
  }
  const retrievedContext = diverseChunks.map((chunk) => ({
    filename: chunk.filename,
    page: chunk.page_number,
    section: chunk.section_title || undefined,
    excerpt: String(chunk.raw_text || '').slice(0, 400),
  }));

  return JSON.stringify({
    tables: tableContext,
    documents: documentContext,
    relevant_document_excerpts: retrievedContext,
  });
}

function requestsNotificationAction(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  return (
    /\b(?:e-?mails?|emailed|emailing)\b/i.test(text) ||
    /\b(?:notify|broadcast|mail)\s+(?:the\s+|affected\s+|all\s+|every\s+|each\s+)?(?:customers?|buyers?|clients?|recipients?|users?|vendors?|suppliers?|managers?|staff|nurses?|them|everyone)\b/i.test(
      text
    ) ||
    /\b(?:send|draft|dispatch)\s+(?:an?\s+|the\s+)?(?:e-?mails?|messages?|notifications?|alerts?|announcements?)\b/i.test(
      text
    )
  );
}

function isActiveTableDocumentSyncDirective(
  prompt,
  documents = [],
  chunks = [],
  entity = null
) {
  const text = String(prompt || '').trim();
  if (!text) return false;

  const hasSyncVerb =
    /\b(?:add|insert|import|append|populate|load|remove|delete|drop|cancel|sync|update|merge)\b/i.test(
      text
    );
  if (!hasSyncVerb) return false;

  // Multi-table / email notifications / policy-rule reconciliation belong to cross_document_operation
  if (
    requestsNotificationAction(text) ||
    /\b(?:reconcile|according\s+to\s+.*\bpolicy\b)\b/i.test(text)
  ) {
    return false;
  }

  const hasPositiveChunks =
    Array.isArray(chunks) && chunks.some((chunk) => Number(chunk.hybrid_score) > 0);
  if (!hasPositiveChunks && (!Array.isArray(documents) || documents.length === 0)) {
    return false;
  }

  const normText = text.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const citesUploadedDoc =
    Array.isArray(documents) &&
    documents.some((doc) => {
      const raw = String(doc?.filename || '').trim().toLowerCase();
      if (!raw) return false;
      if (text.toLowerCase().includes(raw)) return true;
      const stem = raw.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      return stem.length >= 4 && normText.includes(stem);
    });
  const citesGenericDoc =
    /\b(?:from|in|per|listed\s+in|mentioned\s+in|found\s+in|using|via)\s+(?:the\s+|our\s+|this\s+|an?\s+|uploaded\s+){0,2}(?:doc|docs|document|documents|pdf|pdfs|file|files|attachment|report|notice|memo|manifest|letter|bulletin|schedule|roster)\b|\.(?:pdf|docx?|txt|md)\b/i.test(
      text
    );
  if (!citesUploadedDoc && !citesGenericDoc) return false;

  const targetsCurrentTable =
    /\b(?:current|active|this|present)\s+(?:table|sheet|dataset|list)\b|\b(?:to|into|from|in)\s+the\s+(?:table|sheet|dataset)\b/i.test(
      text
    ) ||
    Boolean(
      entity &&
        normText.includes(String(entity).toLowerCase().replace(/[_-]+/g, ' ').trim())
    );
  const clearRowSyncVerb =
    /\b(?:add|insert|import|append|populate|load)\s+(?:all|every|the|new)?\s*(?:[\w\s-]{0,30})\s*(?:rows?|records?|entries|orders?|items?|hires?|shipments?|data)\s+from\b/i.test(
      text
    ) ||
    /\b(?:delete|remove|cancel)\s+(?:all|every|the)?\s*(?:[\w\s-]{0,30})\s*(?:listed|mentioned|shown|found)\s+in\b/i.test(
      text
    );

  return Boolean(targetsCurrentTable || clearRowSyncVerb);
}

function enforceOperationalIntentPrecedence(
  routed,
  prompt,
  chunks,
  activeHistoryContext = null,
  documents = [],
  entity = null
) {
  const text = String(prompt || '').trim();
  const requestsEmail = requestsNotificationAction(text);

  if (routed?.intent === 'document_table_sync') {
    if (requestsEmail) {
      return { ...routed, intent: 'cross_document_operation' };
    }
    return routed;
  }

  const analyticalLead =
    /^(?:which|what|who|when|where|why|how|list|show|find|check|search|look up|identify|cross[- ]reference|evaluate|calculate|compute|compare|summari[sz]e)\b/i.test(
      text
    );
  const directAction =
    /^(?:please\s+)?(?:update|set|change|swap|replace|refund|reconcile|enforce|allocate|assign|deploy|issue|grant|deduct|notify|email|e-mail|send|modify|increase|reduce|decrease|delete|remove|create|add|insert|import|append|populate|sync|cancel|apply|mark)\b/i.test(
      text
    ) ||
    /(?:,|\band\b|\bthen\b)\s*(?:please\s+)?(?:update|set|change|swap|replace|refund|reconcile|enforce|allocate|assign|deploy|issue|grant|deduct|notify|email|e-mail|send|modify|increase|reduce|decrease|delete|remove|create|add|insert|import|append|populate|sync|cancel|apply|mark)\b/i.test(
      text
    ) ||
    /\b(?:i want|i need|please|can you|could you|would you)\s+(?:to\s+)?(?:update|set|change|swap|replace|refund|reconcile|enforce|allocate|assign|deploy|issue|grant|deduct|notify|email|e-mail|send|modify|increase|reduce|decrease|delete|remove|create|add|insert|import|append|populate|sync|cancel|apply|mark)\b/i.test(
      text
    );

  // Preserve the pending turn's intent when the user sends a short clarification reply (e.g., "occupied bed")
  // or a short column/value follow-up immediately after a SHEET_MUTATION turn
  const pendingIntent = activeHistoryContext?.pendingClarification?.baseIntent;
  const resolvedEntity =
    routed?.entity || activeHistoryContext?.activeTargetTable || null;
  if (!analyticalLead && !directAction && pendingIntent) {
    if (
      pendingIntent === 'SHEET_MUTATION' &&
      ['sheet_query', 'clarification_needed', 'conversation'].includes(routed?.intent)
    ) {
      return { ...routed, intent: 'sheet_mutation', entity: resolvedEntity };
    }
    if (
      pendingIntent === 'SHEET_QUERY' &&
      ['clarification_needed', 'conversation'].includes(routed?.intent)
    ) {
      return { ...routed, intent: 'sheet_query', entity: resolvedEntity };
    }
  }

  const lastTurnIntent = String(
    activeHistoryContext?.lastTurn?.resolved_intent || ''
  ).toUpperCase();
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const nonDocNonConvFollowUp =
    wordCount > 0 &&
    wordCount <= 6 &&
    !/^(?:hi|hello|hey|thanks|thank\s+you|bye|yes|no|ok|okay|confirm|cancel)[.!\s]*$/i.test(
      text
    ) &&
    !/\b(?:policy|policies|sop|memo|brief|recall|protocol|guideline|pdf|document|email|e-mail|why|how)\b/i.test(
      text
    );
  if (
    !analyticalLead &&
    !directAction &&
    lastTurnIntent.includes('SHEET_MUTATION') &&
    nonDocNonConvFollowUp &&
    ['sheet_query', 'clarification_needed', 'conversation'].includes(routed?.intent)
  ) {
    return { ...routed, intent: 'sheet_mutation', entity: resolvedEntity };
  }
  const citesGoverningDocInRead =
    (/\b(?:policy|policies|procedure|SOP|manifest|memo|brief|bulletin|recall|protocol|guideline|addendum|notice|document|handbook|manual|rulebook|section\s+\d+|clause|according\s+to)\b/i.test(
      text
    ) ||
      /\b(?:per|under)\s+(?:the\s+|our\s+)?(?:[A-Z][A-Za-z0-9_-]*|policy|policies|sop|protocol|brief|sla|manifest|memo|recall|section|clause|rule|rules|guideline|guidelines)\b/.test(
        text
      )) &&
    Array.isArray(chunks) &&
    chunks.some((chunk) => Number(chunk.hybrid_score) > 0);
  const spansMultipleTables =
    (Array.isArray(routed?.target_entities) && routed.target_entities.length > 1) ||
    (Array.isArray(routed?.prevalidatedPlan?.dependentLookups) &&
      routed.prevalidatedPlan.dependentLookups.length > 0);
  const requiresCrossSourceSynthesis =
    Boolean(routed?.document_grounded) || citesGoverningDocInRead || spansMultipleTables;

  if (
    analyticalLead &&
    !directAction &&
    requiresCrossSourceSynthesis &&
    ['sheet_query', 'cross_source_read', 'cross_document_operation', 'document_question'].includes(
      routed?.intent
    )
  ) {
    return { ...routed, intent: 'cross_source_read' };
  }
  if (
    analyticalLead &&
    !directAction &&
    routed?.intent === 'cross_document_operation' &&
    Array.isArray(chunks) &&
    chunks.length > 0
  ) {
    return { ...routed, intent: 'cross_source_read' };
  }
  if (!directAction) return routed;

  if (
    isActiveTableDocumentSyncDirective(text, documents, chunks, entity || resolvedEntity) &&
    [
      'sheet_mutation',
      'sheet_query',
      'cross_document_operation',
      'document_question',
      'clarification_needed',
    ].includes(routed?.intent)
  ) {
    return { ...routed, intent: 'document_table_sync' };
  }

  const citesGoverningSource =
    /\b(?:policy|procedure|SOP|manifest|memo|brief|recall|guideline|according to|per|under)\b/i.test(
      text
    ) &&
    Array.isArray(chunks) &&
    chunks.some((chunk) => Number(chunk.hybrid_score) > 0);
  const keepCrossDocumentOperation =
    citesGoverningSource ||
    spansMultipleTables ||
    Boolean(routed?.document_grounded) ||
    requestsEmail;
  const intent = keepCrossDocumentOperation
    ? 'cross_document_operation'
    : 'sheet_mutation';
  if (
    ![
      'sheet_query',
      'cross_source_read',
      'sheet_mutation',
      'document_table_sync',
      'cross_document_operation',
      'document_question',
    ].includes(
      routed?.intent
    )
  ) {
    return routed;
  }
  return { ...routed, intent };
}

function isUnambiguousCrossSourceReadCandidate(
  prompt,
  tables = [],
  chunks = [],
  documents = [],
  activeHistoryContext = null
) {
  if (hasCustomWorkspaceGeminiGenerator()) return false;
  if (activeHistoryContext?.pendingClarification) return false;
  if (!Array.isArray(tables) || tables.length === 0) return false;
  if (!Array.isArray(chunks) || !chunks.some((c) => Number(c.hybrid_score) > 0)) {
    return false;
  }

  const text = String(prompt || '').trim();
  if (!text) return false;

  // Reject pure policy/document explanations ("what does the policy say...", "explain...", "summarize...")
  if (
    /^\s*(?:what\s+(?:does|do|did)\s+.*\b(?:say|state|mean|define|specify|require)|(?:can|could|would)\s+you\s+(?:explain|summarize)|explain|summari[sz]e)\b/i.test(
      text
    )
  ) {
    return false;
  }

  // Must start cleanly with a read/question lead (optionally after "According to/Per/Under/Based on ...")
  const leadPattern =
    /^(?:(?:according\s+to|per|under|based\s+on|in)\s+(?:the\s+|our\s+)?[^,?.!]{2,90}[,:]\s*)?(?:which|what\s+(?:rows|records|orders|accounts|backorders|invoices|batches|units|icus|nurses|staff|items|products|shipments)|who|list|show|find|identify|determine|cross[- ]reference|check\s+(?:which|what|all))\b/i;
  if (!leadPattern.test(text)) {
    return false;
  }

  // Reject any mutation, write, or email/notification action instruction
  const actionVerbRegex =
    /(?:^|(?:please|to|and|then|,)\s+)\b(?:update|set|change|swap|replace|refund|reconcile|enforce|allocate|assign|deploy|issue|grant|deduct|notify|email|e-mail|send|modify|increase|reduce|decrease|delete|create|apply|mark|cut|slash|adjust|draft)\b/i;
  const emailInstructionRegex =
    /\b(?:send\s+(?:an?\s+)?e?-?mails?|e?-?mail\s+(?:the|them|all|every|each)|draft\s+(?:an?\s+)?e?-?mails?|notify\s+(?:the|them|all|every|each))\b/i;
  if (actionVerbRegex.test(text) || emailInstructionRegex.test(text)) {
    return false;
  }

  // Must explicitly cite a governing document or policy source (handling Snake_Case_Filenames.pdf as well)
  const citesNamedDoc =
    Array.isArray(documents) &&
    documents.some((doc) => {
      const base = String(doc?.filename || '')
        .replace(/\.[^.]+$/, '')
        .toLowerCase();
      return base.length >= 4 && text.toLowerCase().includes(base);
    });
  const citesDocument =
    citesNamedDoc ||
    /(?:^|[\s_-])(?:policy|policies|procedure|sop|manifest|memo|brief|bulletin|recall|protocol|guideline|addendum|notice|document|handbook|manual|rulebook)(?:$|[\s._-])|\.(?:pdf|docx?|txt|md)\b/i.test(
      text
    ) ||
    /^(?:according\s+to|per|under|based\s+on)\s+/i.test(text);
  if (!citesDocument) {
    return false;
  }

  // Ensure the question references structured record nouns or workspace table/column names
  const mentionsRecordNoun =
    /\b(?:orders?|accounts?|customers?|backorders?|invoices?|batches|batch|records?|rows?|entries|units?|icus?|nurses?|rns?|staff|roster|shipments?|inventory|skus?|products?|items?|vendors?|suppliers?|tickets?|slas?|vouchers?)\b/i.test(
      text
    );
  if (mentionsRecordNoun) return true;

  const lowerPrompt = text.toLowerCase();
  return tables.some((t) => {
    const tName = String(t.tableName || '').toLowerCase();
    const dName = String(t.displayName || '').toLowerCase();
    const nameTokens = [...tName.split(/[^a-z0-9]+/), ...dName.split(/[^a-z0-9]+/)].filter(
      (tok) => tok.length >= 4
    );
    return nameTokens.some((tok) => lowerPrompt.includes(tok));
  });
}

/**
 * Routes a workspace instruction using the active business's available tables,
 * indexed documents, and the current in-memory conversation thread.
 *
 * This is an intent router only: the existing sheet interpreters and validators
 * remain responsible for producing and validating query/mutation plans.
 *
 * @param {object} params
 * @returns {Promise<{intent:string, entity:string|null, answer:string, clarification:string, citations:Array, context:object}>}
 */
async function routeWorkspaceIntent({
  businessId,
  prompt,
  entity = null,
  history = [],
  metadataRows = null,
}) {
  if (!businessId) {
    throw new AppError('A business ID is required to route a workspace instruction.', 400);
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new AppError('A non-empty workspace instruction is required.', 400);
  }

  const conversationalCheck = detectConversationalIntent(prompt);
  if (conversationalCheck.isConversational && (!Array.isArray(history) || history.length === 0)) {
    return {
      intent: 'conversation',
      entity: entity || null,
      target_entities: entity ? [entity] : [],
      answer: conversationalCheck.suggestedReply,
      clarification: '',
      citations: [],
      context: { tables: [], documents: [], chunks: [] },
    };
  }

  const { tables, documents } = await discoverWorkspaceSources(businessId, {
    targetEntity: entity,
    includeRows: false,
    allowEmptyTarget: Boolean(entity),
    prefetchedMetadata: metadataRows,
  });
  const chunks = await retrieveHybridDocumentChunks(businessId, prompt, {
    topK: 8,
    includeAllIfOperational: true,
  });
  const normalizedHistory = normalizeConversationHistory(history);
  const activeHistoryContext = getLatestActiveContext(normalizedHistory, entity || null);

  if (
    isUnambiguousCrossSourceReadCandidate(
      prompt,
      tables,
      chunks,
      documents,
      activeHistoryContext
    )
  ) {
    const fallbackEntity =
      entity || activeHistoryContext.activeTargetTable || (tables.length === 1 ? tables[0].tableName : null);
    return {
      intent: 'cross_source_read',
      entity: fallbackEntity,
      target_entities: [],
      answer: '',
      clarification: '',
      citations: chunks.map((chunk) => chunk.citation).filter(Boolean),
      context: { tables, documents, chunks },
    };
  }

  const currentDateIso = new Date().toISOString().slice(0, 10);
  const sourceContext = formatWorkspaceSources(tables, documents, chunks);
  const formattedHistory = formatConversationHistoryForPrompt(normalizedHistory);

  const promptText = `Route the latest user request in this business workspace (CURRENT_DATE UTC: ${currentDateIso}).

Choose exactly one intent:
- sheet_query: read or search rows in a spreadsheet/table (when no document rule is needed).
- cross_source_read: answer a read-only analytical question by cross-referencing workspace documents and one or more structured tables. Never propose or perform mutations.
- sheet_mutation: change spreadsheet/table rows from prompt values alone, without referencing an uploaded workspace document.
- document_table_sync: add/insert/import new rows, delete/remove rows, or directly update/sync rows ONLY in the currently active table using record data extracted from uploaded workspace documents (e.g., manifests, memos, cancellation notices, supplier sheets, reports), without requesting customer emails or multi-table policy conflict resolution.
- cross_document_operation: use relevant business documents together with table data to plan/execute multi-table policy governance, Socratic conflict resolution (caps, deficits, freezes, waivers), or operations that request sending email notifications.
- document_question: answer a question grounded in uploaded documents, without changing table data.
- conversation: greetings, follow-ups, or general conversation not requesting data changes.
- clarification_needed: ONLY when no tables exist, the user's message is too vague to identify any intended action, or genuine conflict between interpretations cannot be resolved from the schema/excerpts (NEVER use clarification_needed for policy conflicts or column mismatches during a cross_document_operation or document_table_sync).

Rules:
- ${SCHEMA_TRUTH_PRECEDENCE_RULE}
- Use only exact table names ("table" field) listed in ACTIVE BUSINESS SOURCES; if the user's message names or describes a specific table/domain (such as catalog/products, backorders, wholesale accounts, hospital units, or orders), select that matching table from ACTIVE BUSINESS SOURCES even if ACTIVE TABLE differs. Use RECENT CONVERSATION target_table when resolving implicit follow-ups ("those", "them", "that unit", "increase the discount..."); otherwise use ACTIVE TABLE when the user says "this table"/"current table"/"this sheet" or does not identify a different table.
- MULTI-TABLE & CONDITIONAL EVALUATION RULE: If the user's message asks to inspect, cross-check, compare, allocate from, deduct from, or reconcile MULTIPLE tables in ACTIVE BUSINESS SOURCES (including checking availability/stock/capacity in Table B to decide mutations on Table A, or following up on a prior cross-table check), set "entity" to the primary table and list ALL required table names in "target_entities". Whenever a mutation or email operation involves >= 2 tables OR conditional policy/threshold/limit evaluation, classify intent as "cross_document_operation" (never "sheet_mutation") and set "document_grounded": true if workspace documents govern the threshold/limit/rule.
- Loose people nouns ("customers", "buyers", "users", "clients", "accounts") map dynamically to whichever table/column holds buyers/customers/accounts in ACTIVE BUSINESS SOURCES; use RECENT CONVERSATION to stay anchored when following up.
- FIRST-TRY CONCEPTUAL MAPPING RULE: If the user uses conceptual, colloquial, or status-adjacent terms that do not match an exact column name (e.g., vague status, urgency, delay, risk, overload, trouble), inspect all column names, summary, range, and "values" (categorical enums) in ACTIVE BUSINESS SOURCES to infer the closest valid column(s) and enum value(s) on the first attempt—never invent non-existent column names. When multiple valid enum values fit the concept, use operator "in" with a JSON array string (e.g. '["Pending","On Hold"]') and explain the mapping in "interpretation_note".
- UNIFIED READ PLAN RULE (MANDATORY FOR sheet_query AND cross_source_read): Whenever intent is sheet_query or cross_source_read, you MUST return a non-empty "table_queries" array in this same JSON response using exact column names and supported operators from ACTIVE BUSINESS SOURCES (never return SQL). Never omit "table_queries" on a read intent. Apply DATE / DORMANCY DIRECTION RULE ("inactive/older than N days" => date column "less_than_or_equal" CURRENT_DATE minus N days) and DOCUMENT-ENUMERATED CODES RULE ("in" filter on explicit codes from excerpts).
- TWO-STAGE CROSS-TABLE READ RULE: Whenever a read request compares or cross-checks rows across two tables (e.g., comparing orders/requests in Table A against stock/inventory/capacity in Table B), DO NOT reduce it to a static single-table filter! Instead:
  1. Emit the anchor query in "table_queries" with "query_id": "anchor_1" (filtering via "in" on prior matched_row_ids from RECENT CONVERSATION, or using "order_by"+"limit" for the latest N rows).
  2. Emit a "dependent_lookups" entry linking "source_query_id": "anchor_1" via "source_join_column" to "target_table" and "target_join_column" ("match_mode": "case_insensitive" or "normalized_string"). NEVER join onto an internal UUID "id" column unless the anchor column also contains UUIDs; always join on matching business keys/names/codes (such as target table's "primary_key" or matching *_name <-> name / *_code <-> code columns) and provide "fallback_source_join_column"/"fallback_target_join_column" when a secondary key exists.
  3. Emit "cross_table_comparisons" for the cross-table arithmetic & policy threshold (e.g., left_source: "lookup_1", left_column: <live stock/capacity col>, operator: "-", right_source: "anchor_1", right_column: <live requested col>, result_alias: "remaining_after_request", threshold_filter: { "op": "<", "value": <policy minimum/buffer threshold from relevant_document_excerpts, or 0 if no minimum buffer applies> }).
  Return "table_queries": [], "dependent_lookups": [], "cross_table_comparisons": [] for sheet_mutation, document_table_sync, cross_document_operation, document_question, conversation, or clarification_needed.
- Set "document_grounded": true ONLY when answering or executing requires rules, thresholds, buffers, limits, or identifiers from relevant_document_excerpts (or explicitly cites a policy/SOP/manifest/document); set "document_grounded": false when table columns and enum values alone suffice.
- Never infer permission to mutate, send email, or other external actions from a pure question. Only classify the requested intent.
- Use RECENT CONVERSATION (up to 5 prior turns) to resolve anaphoric/implicit follow-ups ("those", "them", "only the ones...", "that unit", "the N new orders"), clarification replies (when prior turn asked for clarification and user supplies the missing fragment like "occupied bed", inherit that prior turn's intent such as sheet_mutation and target_table), or inherited scope.
- For document_question and conversation, provide a concise answer in "answer". For other intents, "answer" should be "".
- Return ONLY a JSON object with these keys:
  - "intent": one of ["sheet_query","cross_source_read","sheet_mutation","document_table_sync","cross_document_operation","document_question","conversation","clarification_needed"]
  - "entity": exact primary table name from ACTIVE BUSINESS SOURCES (or "")
  - "target_entities": array of exact table names involved
  - "document_grounded": boolean (true ONLY if uploaded document rules/thresholds/codes are required to answer or execute)
  - "interpretation_note": 1-sentence explanation when mapping conceptual/colloquial terms to columns and enum values (or "")
  - "table_queries": array of { "query_id": string, "table_name": string, "filters": [{ "field": string, "operator": "equals"|"not_equals"|"contains"|"not_contains"|"starts_with"|"ends_with"|"in"|"greater_than"|"greater_than_or_equal"|"less_than"|"less_than_or_equal"|"between"|"relative_days_ago"|"this_month", "value": string }], "calculation_filters": [{ "operation": "add"|"subtract"|"multiply"|"divide", "fields": [string, string], "operator": "greater_than"|"greater_than_or_equal"|"less_than"|"less_than_or_equal"|"equals"|"not_equals"|"between", "value": string }], "filter_logic": "AND"|"OR", "order_by": [{ "field": string, "direction": "asc"|"desc" }], "sort": [{ "field": string, "direction": "asc"|"desc" }], "limit": number, "aggregates": [{ "operation": "count"|"sum"|"average"|"min"|"max", "field": string }], "calculations": [{ "operation": "add"|"subtract"|"multiply"|"divide", "fields": [string, string], "aggregate": "count"|"sum"|"average"|"min"|"max" }] } — REQUIRED non-empty array when intent is sheet_query or cross_source_read; [] for other intents
  - "dependent_lookups": array of { "lookup_id": string, "source_query_id": string, "source_join_column": string, "target_table": string, "target_join_column": string, "fallback_source_join_column": string, "fallback_target_join_column": string, "match_mode": "exact"|"case_insensitive"|"normalized_string" } — optional for cross-table reads; [] otherwise
  - "cross_table_comparisons": array of { "left_source": string, "left_column": string, "operator": "-"|"+"|"*"|"/", "right_source": string, "right_column": string, "result_alias": string, "threshold_filter": { "op": "<"|"<="|">"|">="|"=="|"!=", "value": number } } — optional for cross-table math/thresholds; [] otherwise
  - "answer": concise grounded reply ONLY for document_question or conversation ("" otherwise)
  - "clarification": concise question ONLY for clarification_needed ("" otherwise)

ACTIVE BUSINESS SOURCES:
${sourceContext}

RECENT CONVERSATION (5-turn sliding window; prior matched_row_ids: ${JSON.stringify((activeHistoryContext.matchedRowIds || []).slice(0, 30))}):
${formattedHistory || '[]'}

PRIOR ACTIVE TABLE FROM CONVERSATION (if any): ${activeHistoryContext.activeTargetTable || 'none'}
ACTIVE TABLE (if any): ${entity || 'not specified'}

LATEST USER MESSAGE:
${prompt.trim()}`;

  const routed = await generateStructuredJsonWithRetry(
    promptText,
    (parsed) => {
      const intent = String(parsed?.intent || '').trim();
      if (!WORKSPACE_INTENTS.has(intent)) {
        throw new AppError(`Gemini returned unsupported workspace intent "${intent}".`, 502);
      }

      const resolveTableName = (candidate) => {
        const raw = String(candidate || '').trim();
        if (!raw) return null;
        const stripped = raw.replace(/\.(csv|xlsx?|tsv)$/i, '').trim();
        const normalized = stripped ? normalizeEntityName(stripped).toLowerCase() : '';
        return (
          tables.find((table) => {
            const tLower = table.tableName.toLowerCase();
            const dLower = String(table.displayName || '').toLowerCase();
            return (
              tLower === raw.toLowerCase() ||
              tLower === stripped.toLowerCase() ||
              tLower === normalized ||
              dLower === raw.toLowerCase() ||
              dLower === stripped.toLowerCase()
            );
          })?.tableName || null
        );
      };

      const rawRequested = String(
        parsed?.entity || activeHistoryContext.activeTargetTable || entity || ''
      ).trim();
      let resolvedEntity = resolveTableName(rawRequested);

      if (!resolvedEntity && tables.length === 1) {
        resolvedEntity = tables[0].tableName;
      }

      const resolvedTargetEntities = [];
      const seenResolved = new Set();
      const pushResolved = (tblName) => {
        if (tblName && !seenResolved.has(tblName.toLowerCase())) {
          seenResolved.add(tblName.toLowerCase());
          resolvedTargetEntities.push(tblName);
        }
      };
      pushResolved(resolvedEntity);
      if (Array.isArray(parsed?.target_entities)) {
        for (const extra of parsed.target_entities) {
          pushResolved(resolveTableName(extra));
        }
      }
      if (!resolvedEntity && resolvedTargetEntities.length > 0) {
        resolvedEntity = resolvedTargetEntities[0];
      }

      if (
        ['sheet_query', 'sheet_mutation', 'document_table_sync', 'cross_document_operation'].includes(
          intent
        ) &&
        !resolvedEntity &&
        tables.length > 1
      ) {
        if (intent === 'document_table_sync' && entity) {
          resolvedEntity = resolveTableName(entity) || entity;
        } else {
          throw new Error(
            `Invalid or missing entity "${rawRequested}". Select the exact matching "table" name from ACTIVE BUSINESS SOURCES: ${tables.map((t) => t.tableName).join(', ')}.`
          );
        }
      }

      if (
        ['sheet_query', 'sheet_mutation', 'cross_document_operation'].includes(intent) &&
        !resolvedEntity
      ) {
        return {
          intent: 'clarification_needed',
          entity: null,
          target_entities: [],
          document_grounded: false,
          interpretation_note: '',
          prevalidatedPlan: null,
          answer: '',
          clarification:
            'I could not identify a matching table in this business workspace. Please select or name the table.',
          citations: [],
          context: { tables, documents, chunks },
        };
      }

      let prevalidatedPlan = null;
      if (
        ['sheet_query', 'cross_source_read'].includes(intent) &&
        Array.isArray(parsed?.table_queries) &&
        parsed.table_queries.length > 0
      ) {
        try {
          const validated = validateReadPlan(
            {
              table_queries: parsed.table_queries,
              dependent_lookups: Array.isArray(parsed?.dependent_lookups)
                ? parsed.dependent_lookups
                : [],
              cross_table_comparisons: Array.isArray(parsed?.cross_table_comparisons)
                ? parsed.cross_table_comparisons
                : [],
            },
            tables,
            prompt,
            chunks
          );
          if (Array.isArray(validated) && validated.length > 0) {
            prevalidatedPlan = validated;
            for (const lookup of validated.dependentLookups || []) {
              pushResolved(lookup.targetTable?.tableName);
            }
          }
        } catch {
          // Soft fallback: downstream read planner will re-plan cleanly if needed
          prevalidatedPlan = null;
        }
      }

      return {
        intent,
        entity: resolvedEntity,
        target_entities: resolvedTargetEntities,
        document_grounded: Boolean(parsed?.document_grounded),
        interpretation_note: String(parsed?.interpretation_note || '').trim(),
        prevalidatedPlan,
        answer: String(parsed?.answer || '').trim(),
        clarification: String(parsed?.clarification || '').trim(),
        citations: chunks.map((chunk) => chunk.citation).filter(Boolean),
        context: { tables, documents, chunks },
      };
    },
    {
      maxRetries: 1,
      responseSchema: null,
      stage: 'route_and_plan',
    }
  );

  return enforceOperationalIntentPrecedence(
    routed,
    prompt,
    chunks,
    activeHistoryContext,
    documents,
    routed?.entity || entity
  );
}

module.exports = {
  WORKSPACE_INTENTS,
  formatWorkspaceSources,
  isActiveTableDocumentSyncDirective,
  enforceOperationalIntentPrecedence,
  isUnambiguousCrossSourceReadCandidate,
  routeWorkspaceIntent,
};
