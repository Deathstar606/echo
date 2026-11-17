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
const AppError = require('../utils/AppError');

const WORKSPACE_INTENTS = new Set([
  'sheet_query',
  'cross_source_read',
  'sheet_mutation',
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
    answer: {
      type: 'STRING',
      description: 'A concise grounded reply for conversational or document questions',
    },
    clarification: {
      type: 'STRING',
      description: 'What needs clarification when intent or target is genuinely ambiguous',
    },
  },
  required: ['intent'],
};

function formatWorkspaceSources(tables, documents, chunks) {
  const tableContext = tables.map(({ tableName, displayName, rowCount, schema, metadata }) => {
    const profileByCol = new Map();
    for (const colProfile of metadata?.columns_profile || []) {
      if (colProfile?.column_name) {
        profileByCol.set(String(colProfile.column_name).toLowerCase(), colProfile);
      }
    }
    return {
      table: tableName,
      display_name: displayName,
      row_count: typeof rowCount === 'number' ? rowCount : undefined,
      primary_key: metadata?.primary_key_column || undefined,
      columns: Object.values(schema.columns || {}).map((column) => {
        const prof = profileByCol.get(String(column.exactName).toLowerCase());
        const isEmail = prof?.semantic_role === 'email';
        return {
          name: column.exactName,
          type: column.type,
          mutable: Boolean(column.modifiable && !column.virtual),
          role: prof?.semantic_role || undefined,
          values:
            !isEmail && Array.isArray(prof?.categorical_values) && prof.categorical_values.length > 0
              ? prof.categorical_values.slice(0, 4)
              : undefined,
          nested_keys: prof?.nested_structure || undefined,
        };
      }),
    };
  });
  const documentContext = documents.map((document) => ({
    filename: document.filename,
    page_count: document.page_count,
  }));
  const positiveChunks = (chunks || []).filter((c) => Number(c.hybrid_score) > 0);
  const chunkPool = positiveChunks.length > 0 ? positiveChunks : chunks || [];
  const retrievedContext = chunkPool.slice(0, 4).map((chunk) => ({
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

function enforceOperationalIntentPrecedence(
  routed,
  prompt,
  chunks,
  activeHistoryContext = null
) {
  const text = String(prompt || '').trim();
  const analyticalLead =
    /^(?:which|what|who|when|where|why|how|list|show|find|check|search|look up|identify|cross[- ]reference|evaluate|calculate|compute|compare|summari[sz]e)\b/i.test(
      text
    );
  const directAction =
    /^(?:please\s+)?(?:update|set|change|swap|replace|refund|reconcile|enforce|allocate|assign|deploy|issue|grant|deduct|notify|email|e-mail|send|modify|increase|reduce|decrease|delete|create|apply|mark)\b/i.test(
      text
    ) ||
    /(?:,|\band\b|\bthen\b)\s*(?:please\s+)?(?:update|set|change|swap|replace|refund|reconcile|enforce|allocate|assign|deploy|issue|grant|deduct|notify|email|e-mail|send|modify|increase|reduce|decrease|delete|create|apply|mark)\b/i.test(
      text
    ) ||
    /\b(?:i want|i need|please|can you|could you|would you)\s+(?:to\s+)?(?:update|set|change|swap|replace|refund|reconcile|enforce|allocate|assign|deploy|issue|grant|deduct|notify|email|e-mail|send|modify|increase|reduce|decrease|delete|create|apply|mark)\b/i.test(
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
  if (
    analyticalLead &&
    !directAction &&
    ((Array.isArray(chunks) && chunks.length > 0) ||
      (Array.isArray(routed?.target_entities) && routed.target_entities.length > 1))
  ) {
    return { ...routed, intent: 'cross_source_read' };
  }
  if (!directAction) return routed;

  const citesGoverningSource =
    /\b(?:policy|procedure|SOP|manifest|memo|brief|recall|guideline|according to|per|under)\b/i.test(
      text
    ) &&
    Array.isArray(chunks) &&
    chunks.some((chunk) => Number(chunk.hybrid_score) > 0);
  const intent = citesGoverningSource
    ? 'cross_document_operation'
    : 'sheet_mutation';
  if (
    ![
      'sheet_query',
      'cross_source_read',
      'sheet_mutation',
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

  const sourceContext = formatWorkspaceSources(tables, documents, chunks);
  const formattedHistory = formatConversationHistoryForPrompt(normalizedHistory);

  const promptText = `Route the latest user request in this business workspace.

Choose exactly one intent:
- sheet_query: read or search rows in a spreadsheet/table.
- cross_source_read: answer a read-only analytical question by cross-referencing workspace documents and one or more structured tables. This is for questions/calculations only; never propose or perform mutations.
- sheet_mutation: change spreadsheet/table rows, without a document-derived cross-source dependency.
- cross_document_operation: use relevant business documents together with table data to plan/execute an operation, including requested notifications. ALWAYS select cross_document_operation whenever the user asks to apply/update/upgrade/allocate/process records using rules from memos, policies, manifests, briefs, SOPs, or recalls — EVEN IF the documents contain policy conflicts, governance options, caps, deficits, "CLARIFICATION_REQUIRED" rules, or dataset/column mismatches (the downstream Socratic engine handles those!).
- document_question: answer a question grounded in uploaded documents, without changing table data.
- conversation: greetings, follow-ups, or general conversation not requesting data changes.
- clarification_needed: ONLY when no tables exist or the user's message is too vague to identify any intended action (NEVER use clarification_needed for policy conflicts, option choices, or column mismatches during a cross-document operation).

Rules:
- Use only exact table names ("table" field) listed in ACTIVE BUSINESS SOURCES; if the user's message names or describes a specific table/domain (such as catalog/products, backorders, wholesale accounts, or orders), select that matching table from ACTIVE BUSINESS SOURCES even if ACTIVE TABLE differs. Use RECENT CONVERSATION target_table when resolving implicit follow-ups ("those", "them", "that unit", "increase the discount..."); otherwise use ACTIVE TABLE only when the user says "this sheet" or does not identify a different table.
- If the user's message explicitly instructs updating or reconciling MULTIPLE tables in ACTIVE BUSINESS SOURCES (for example, reconciling open backorders in "backorders_dataset" AND updating remaining available stock in "products"), set "entity" to the primary transactional table (e.g., "backorders_dataset") and list ALL required table names in "target_entities". Do NOT add a second table to "target_entities" unless the user's message itself asks to inspect or update that second table.
- A request to query or mutate a table is not automatically a cross_document_operation just because documents exist.
- For analytical questions such as "which rows need a status update?" or "what would the policy require?", use cross_source_read unless the user directly instructs you to make a state change or send a notification.
- Select cross_document_operation whenever the requested table update/notification depends on facts, thresholds, batches, SKUs, or rules in one or more uploaded documents.
- Never infer permission to mutate, send email, or other external actions from a pure question. Only classify the requested intent.
- Never invent a table, column, document, rule, or answer.
- Nested-map keys in metadata are examples observed in sampled records, not guarantees that each record contains those keys. Apply operations on existing entries per matching record; create missing keys only when the user explicitly asks for creation.
- Use RECENT CONVERSATION (up to 5 prior turns) to resolve anaphoric/implicit follow-ups ("those", "them", "only the ones...", "that unit", "increase the discount to 20%"), clarification replies (when the prior turn asked for clarification and the user supplies the missing column/value fragment like "occupied bed", inherit that prior turn's intent such as sheet_mutation and target_table), or inherited scope; NEVER emit clarification_needed merely because the target table, action, or filter was specified in a prior turn in RECENT CONVERSATION.
- For document_question and conversation, provide a concise answer in "answer". For other intents, "answer" should be empty.
- Return JSON matching the requested response schema only.

ACTIVE BUSINESS SOURCES:
${sourceContext}

RECENT CONVERSATION (5-turn sliding window):
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
        ['sheet_query', 'sheet_mutation', 'cross_document_operation'].includes(intent) &&
        !resolvedEntity &&
        tables.length > 1
      ) {
        throw new Error(
          `Invalid or missing entity "${rawRequested}". Select the exact matching "table" name from ACTIVE BUSINESS SOURCES: ${tables.map((t) => t.tableName).join(', ')}.`
        );
      }

      if (
        ['sheet_query', 'sheet_mutation', 'cross_document_operation'].includes(intent) &&
        !resolvedEntity
      ) {
        return {
          intent: 'clarification_needed',
          entity: null,
          target_entities: [],
          answer: '',
          clarification:
            'I could not identify a matching table in this business workspace. Please select or name the table.',
          citations: [],
          context: { tables, documents, chunks },
        };
      }

      return {
        intent,
        entity: resolvedEntity,
        target_entities: resolvedTargetEntities,
        answer: String(parsed?.answer || '').trim(),
        clarification: String(parsed?.clarification || '').trim(),
        citations: chunks.map((chunk) => chunk.citation).filter(Boolean),
        context: { tables, documents, chunks },
      };
    },
    {
      maxRetries: 1,
      responseSchema: WORKSPACE_INTENT_SCHEMA,
      stage: 'intent_routing',
    }
  );

  return enforceOperationalIntentPrecedence(routed, prompt, chunks, activeHistoryContext);
}

module.exports = {
  WORKSPACE_INTENTS,
  formatWorkspaceSources,
  enforceOperationalIntentPrecedence,
  isUnambiguousCrossSourceReadCandidate,
  routeWorkspaceIntent,
};
