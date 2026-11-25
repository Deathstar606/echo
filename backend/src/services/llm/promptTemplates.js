const {
  SCHEMA_TRUTH_PRECEDENCE_RULE,
  serializeTableForPrompt,
} = require('../../utils/schemaPromptSerializer');

/**
 * Dual Persona System Prompt #1 (Internal Operator: entity="user", <= 400 tokens)
 */
const OPS_ANALYST_SYSTEM_PROMPT = `You are Echo Operations Analyst, an internal B2B data and policy reasoning assistant.
Core rules:
1. ${SCHEMA_TRUTH_PRECEDENCE_RULE}
2. Cite exact verified document chunk_id/filename+locator and table row_identifier values from tool outputs. Never invent numbers, rows, or citations.
3. Rely strictly on deterministic tool results (never estimate or fabricate SQL math).
4. Keep reasoning crisp and tool calls minimal (max 3 ReAct steps). Combine read-only lookups in parallel when possible.
5. Human-in-the-Loop safety: NEVER commit SQL mutations or send emails directly. Only propose Stage 1 diffs/drafts via tools for human approval.
6. Return strictly valid JSON matching the requested output schema.`;

/**
 * Dual Persona System Prompt #2 (Customer Facing: entity="customer", <= 400 tokens)
 */
const CUSTOMER_CARE_SYSTEM_PROMPT = `You are Echo Customer Care Representative, a polite, clear, helpful customer support assistant.
Core rules:
1. Answer strictly using verified active workspace policy chunks and ONLY this customer's own matched records.
2. PERSONA & PRIVACY ISOLATION: NEVER reveal internal database table names, raw SQL snake_case column names, internal margin/credit-hold underwriting jargon, internal staff/hub-lead/coordinator email addresses, or any other customer's records.
3. Translate policy numbers and statuses into clear, courteous customer language.
4. NEVER propose database mutations or send bulk/operational emails. Read-only inquiry resolution only.
5. Cite user-facing policy document names cleanly without leaking internal system IDs.
6. Return strictly valid JSON matching the requested output schema.`;

/**
 * Strictly 2 ultra-short, domain-agnostic examples used ONLY inside Intent Router & Query Expansion.
 */
const ROUTER_FEW_SHOT_EXAMPLES = Object.freeze([
  {
    user_query: 'are we short on anything for the new stuff?',
    prior_turn_hint: 'Turn 1 created 4 rows in requests_table',
    output: {
      intent: 'CROSS_SOURCE_READ',
      confidence: 0.94,
      primary_table: 'requests_table',
      target_tables: ['requests_table', 'inventory_table'],
      expanded_queries: [
        'minimum safety reserve buffer stock policy',
        'pending requests compared against available inventory quantity',
      ],
      doc_types: null,
      requires_multi_table: true,
      requests_email: false,
      target_audience_scope: 'none',
    },
  },
  {
    user_query: 'allocate what we safely can under the reserve buffer and email every buyer their status',
    prior_turn_hint: 'Cross-checked open requests vs inventory reserve limit',
    output: {
      intent: 'AGENTIC_OPERATION',
      confidence: 0.96,
      primary_table: 'requests_table',
      target_tables: ['requests_table', 'inventory_table'],
      expanded_queries: [
        'minimum reserve buffer allocation rule',
        'fulfilled and backordered status buyer email notification policy',
      ],
      doc_types: ['policy', 'sop'],
      requires_multi_table: true,
      requests_email: true,
      target_audience_scope: 'primary_customers_only',
    },
  },
]);

function formatSerializedTables(tables = []) {
  const serialized = (Array.isArray(tables) ? tables : []).map((t) =>
    t && t.columns && !t.schema
      ? t
      : serializeTableForPrompt(t, { includeMutability: true })
  );
  return JSON.stringify({
    schema_rule: SCHEMA_TRUTH_PRECEDENCE_RULE,
    tables: serialized,
  });
}

function formatMemoryItems(memoryTurns = []) {
  if (!Array.isArray(memoryTurns) || memoryTurns.length === 0) return '';
  const lines = memoryTurns.map((t) => {
    if (typeof t === 'string') return t;
    const tables = Array.isArray(t.touched_tables) ? t.touched_tables.join(',') : '';
    const keys = Array.isArray(t.touched_row_keys) ? t.touched_row_keys.join(',') : '';
    const docs = Array.isArray(t.touched_doc_citations) ? t.touched_doc_citations.join(',') : '';
    return [
      `[Turn ${t.turn_number ?? '?'}]`,
      `Intent: ${t.user_intent_summary || ''}`,
      `Action: ${t.action_taken || ''}`,
      tables ? `Tables: ${tables}` : '',
      keys ? `Keys: ${keys}` : '',
      docs ? `Docs: ${docs}` : '',
      t.outcome_summary ? `Outcome: ${t.outcome_summary}` : '',
    ]
      .filter(Boolean)
      .join(' | ');
  });
  return `COMPACT 5-TURN MEMORY (oldest->newest):\n${lines.join('\n')}`;
}

function formatChunkItems(chunksLowestFirst = []) {
  if (!Array.isArray(chunksLowestFirst) || chunksLowestFirst.length === 0) return '';
  const payload = chunksLowestFirst.map((c, idx) => ({
    rank_from_top: chunksLowestFirst.length - idx,
    chunk_id: c.chunk_id || c.id || `chunk-${idx + 1}`,
    filename: c.filename || c.source_name || 'document',
    locator: c.locator || `Page ${c.page_number || 1}`,
    doc_type: c.doc_type || 'general',
    breadcrumb: c.breadcrumb_header || undefined,
    text: String(c.raw_text || c.text || '').slice(0, 750),
  }));
  return `HYBRID RRF DOCUMENT CHUNKS (ordered lowest-rank to highest-rank; Rank 1 at bottom):\n${JSON.stringify(payload)}`;
}

function formatSqlObservationItems(observations = []) {
  if (!Array.isArray(observations) || observations.length === 0) return '';
  return `TOOL & POSTGRESQL OBSERVATIONS:\n${JSON.stringify(observations)}`;
}

/**
 * Builds an ordered prompt block array maximizing prefix cache hits:
 * Block 1 (Static Prefix): System Prompt -> Tool Definitions -> Serialized Table Metadata
 * Block 2 (Dynamic Suffix): 5-Turn Memory -> Top-K RRF Chunks (lowest->highest) -> SQL Rows/Observations -> User Prompt
 *
 * @param {object} params
 */
function buildCacheOrderedPrompt({
  entity = 'user',
  toolDefinitions = null,
  tables = [],
  fewShotExamples = null,
  memoryTurns = [],
  rrfChunks = [],
  sqlObservations = [],
  userPrompt = '',
  extraInstruction = '',
}) {
  const normalizedEntity = String(entity || 'user').trim().toLowerCase();
  const systemText =
    normalizedEntity === 'customer'
      ? CUSTOMER_CARE_SYSTEM_PROMPT
      : OPS_ANALYST_SYSTEM_PROMPT;

  // Order RRF chunks lowest-rank to highest-rank so Rank #1 sits closest to the bottom
  const sortedChunksHighFirst = [...(Array.isArray(rrfChunks) ? rrfChunks : [])];
  const chunksLowestFirst = [...sortedChunksHighFirst].reverse();

  const blocks = [
    // --- BLOCK 1: STATIC CACHEABLE PREFIX ---
    {
      id: 'system_prompt',
      role: 'static',
      kind: 'system',
      protected: true,
      content: systemText,
    },
  ];

  if (toolDefinitions && Array.isArray(toolDefinitions) && toolDefinitions.length > 0) {
    blocks.push({
      id: 'tool_definitions',
      role: 'static',
      kind: 'tools',
      protected: true,
      content: `AVAILABLE TOOLS (JSON SCHEMA):\n${JSON.stringify(toolDefinitions)}`,
    });
  }

  blocks.push({
    id: 'table_metadata',
    role: 'static',
    kind: 'table_metadata',
    protected: true,
    content: `WORKSPACE TABLE METADATA:\n${formatSerializedTables(tables)}`,
  });

  if (Array.isArray(fewShotExamples) && fewShotExamples.length > 0) {
    blocks.push({
      id: 'router_few_shots',
      role: 'static',
      kind: 'tools',
      protected: true,
      content: `ROUTER EXAMPLES:\n${JSON.stringify(fewShotExamples.slice(0, 2))}`,
    });
  }

  // --- BLOCK 2: DYNAMIC PER-TURN SUFFIX ---
  if (Array.isArray(memoryTurns) && memoryTurns.length > 0) {
    blocks.push({
      id: 'turn_memory',
      role: 'dynamic',
      kind: 'memory',
      protected: false,
      items: memoryTurns,
      render: formatMemoryItems,
    });
  }

  if (chunksLowestFirst.length > 0) {
    blocks.push({
      id: 'rrf_chunks',
      role: 'dynamic',
      kind: 'rrf_chunks',
      protected: false,
      items: chunksLowestFirst,
      render: formatChunkItems,
    });
  }

  if (Array.isArray(sqlObservations) && sqlObservations.length > 0) {
    blocks.push({
      id: 'sql_rows',
      role: 'dynamic',
      kind: 'sql_rows',
      protected: false,
      items: sqlObservations,
      render: formatSqlObservationItems,
    });
  }

  const finalUserBlockText = [
    extraInstruction ? String(extraInstruction).trim() : '',
    `CURRENT USER REQUEST:\n${String(userPrompt || '').trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  blocks.push({
    id: 'user_prompt',
    role: 'dynamic',
    kind: 'user_prompt',
    protected: true,
    content: finalUserBlockText,
  });

  return {
    blocks,
    renderStaticPrefix() {
      return blocks
        .filter((b) => b.role === 'static')
        .map((b) => (typeof b.render === 'function' ? b.render(b.items) : b.content))
        .filter(Boolean)
        .join('\n\n');
    },
    renderDynamicSuffix() {
      return blocks
        .filter((b) => b.role === 'dynamic')
        .map((b) => (typeof b.render === 'function' ? b.render(b.items) : b.content))
        .filter(Boolean)
        .join('\n\n');
    },
  };
}

module.exports = {
  OPS_ANALYST_SYSTEM_PROMPT,
  CUSTOMER_CARE_SYSTEM_PROMPT,
  ROUTER_FEW_SHOT_EXAMPLES,
  buildCacheOrderedPrompt,
  formatSerializedTables,
  formatMemoryItems,
  formatChunkItems,
};
