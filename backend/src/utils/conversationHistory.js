const MAX_CONVERSATION_TURNS = 5;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FOLLOW_UP_REFERENCE_REGEX =
  /\b(?:those|them|these|their|its|that\s+(?:unit|order|account|product|record|row|item|batch|invoice|list|set|cohort|subset)|the\s+(?:ones?|same|above|matched|filtered|selected|remaining|customers?|buyers?|clients?|recipients?|accounts?|orders?|units?|patients?|nurses?|contacts?|rows?|records?|items?|products?)|(?:all\s+)?(?:affected|selected|matched|filtered|delayed|impacted)\s+(?:customers?|buyers?|clients?|recipients?|accounts?|orders?|units?|rows?|records?)|from\s+(?:those|them|these|that)|among\s+(?:those|them|these)|of\s+(?:those|them|these)|with\s+only|narrow\s+(?:that|this|it|them|those)\s*(?:down)?|filter\s+(?:those|them|these|it|that))\b/i;

const SCOPE_RESET_REGEX =
  /\b(?:across\s+(?:all|the\s+(?:whole|entire)\s+(?:table|sheet|dataset))|in\s+the\s+(?:whole|entire)\s+(?:table|sheet|dataset)|from\s+the\s+(?:whole|entire)\s+(?:table|sheet|dataset)|all\s+rows\s+in\s+(?:the\s+)?(?:table|sheet)|ignore\s+previous|start\s+over)\b/i;

/**
 * Normalizes structured ConversationHistoryTurn[] or legacy { role, content }[]
 * into a 5-turn sliding window array.
 *
 * @param {Array<object>} [rawHistory]
 * @returns {Array<{
 *   turn_index: number,
 *   user_prompt: string,
 *   resolved_intent: string,
 *   target_table: string | null,
 *   matched_row_ids: string[],
 *   applied_filter_summary: string,
 *   assistant_response_summary: string
 * }>}
 */
function normalizeConversationHistory(rawHistory) {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
    return [];
  }

  const turns = [];
  let pendingLegacyUser = null;

  for (let i = 0; i < rawHistory.length; i += 1) {
    const item = rawHistory[i];
    if (!item || typeof item !== 'object') continue;

    if (typeof item.user_prompt === 'string') {
      const userPrompt = item.user_prompt.trim();
      if (!userPrompt) continue;
      const matchedIds = Array.isArray(item.matched_row_ids)
        ? [...new Set(item.matched_row_ids.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 200)
        : [];
      turns.push({
        turn_index: Number.isFinite(Number(item.turn_index))
          ? Number(item.turn_index)
          : turns.length + 1,
        user_prompt: userPrompt.slice(0, 800),
        resolved_intent: String(item.resolved_intent || '').trim(),
        target_table: item.target_table ? String(item.target_table).trim() : null,
        matched_row_ids: matchedIds,
        applied_filter_summary: String(item.applied_filter_summary || '').trim().slice(0, 400),
        assistant_response_summary: String(item.assistant_response_summary || '').trim().slice(0, 800),
      });
      continue;
    }

    // Backward-compatibility for legacy { role: 'user'|'assistant', content } arrays
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const content = String(item.content || '').trim();
    if (!content) continue;

    if (role === 'user') {
      if (pendingLegacyUser) {
        turns.push(pendingLegacyUser);
      }
      pendingLegacyUser = {
        turn_index: turns.length + 1,
        user_prompt: content.slice(0, 800),
        resolved_intent: String(item.resolved_intent || '').trim(),
        target_table: item.target_table ? String(item.target_table).trim() : null,
        matched_row_ids: Array.isArray(item.matched_row_ids)
          ? item.matched_row_ids.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 200)
          : [],
        applied_filter_summary: String(item.applied_filter_summary || '').trim().slice(0, 400),
        assistant_response_summary: '',
      };
    } else if (pendingLegacyUser) {
      pendingLegacyUser.assistant_response_summary = content.slice(0, 800);
      if (item.target_table && !pendingLegacyUser.target_table) {
        pendingLegacyUser.target_table = String(item.target_table).trim();
      }
      if (Array.isArray(item.matched_row_ids) && pendingLegacyUser.matched_row_ids.length === 0) {
        pendingLegacyUser.matched_row_ids = item.matched_row_ids
          .map((id) => String(id || '').trim())
          .filter(Boolean)
          .slice(0, 200);
      }
      turns.push(pendingLegacyUser);
      pendingLegacyUser = null;
    }
  }

  if (pendingLegacyUser) {
    turns.push(pendingLegacyUser);
  }

  return turns.slice(-MAX_CONVERSATION_TURNS);
}

/**
 * Resolves the active table and prior matched row scope from normalized history.
 *
 * @param {Array<object>} normalizedHistory
 * @param {string | null} [preferredTable=null]
 */
function getLatestActiveContext(normalizedHistory = [], preferredTable = null) {
  const list = Array.isArray(normalizedHistory) ? normalizedHistory : [];
  if (list.length === 0) {
    return {
      lastTurn: null,
      activeTargetTable: preferredTable || null,
      matchedRowIds: [],
      appliedFilterSummary: '',
      fromTurnIndex: null,
    };
  }

  const lastTurn = list[list.length - 1];
  const preferredNorm = preferredTable
    ? String(preferredTable).trim().toLowerCase()
    : null;

  let activeTargetTable = preferredTable ? String(preferredTable).trim() : null;
  if (!activeTargetTable) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].target_table) {
        activeTargetTable = list[i].target_table;
        break;
      }
    }
  }

  const targetNorm = activeTargetTable ? activeTargetTable.toLowerCase() : null;
  let matchedRowIds = [];
  let appliedFilterSummary = '';
  let fromTurnIndex = null;

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const turn = list[i];
    const turnTableNorm = turn.target_table ? turn.target_table.toLowerCase() : null;
    if (targetNorm && turnTableNorm && turnTableNorm !== targetNorm) {
      // Stop walking backward once conversation explicitly shifted from another table
      if (preferredNorm && turnTableNorm !== preferredNorm) {
        break;
      }
      continue;
    }
    if (Array.isArray(turn.matched_row_ids) && turn.matched_row_ids.length > 0) {
      matchedRowIds = turn.matched_row_ids;
      appliedFilterSummary = turn.applied_filter_summary || '';
      fromTurnIndex = turn.turn_index;
      break;
    }
    if (!appliedFilterSummary && turn.applied_filter_summary) {
      appliedFilterSummary = turn.applied_filter_summary;
      fromTurnIndex = turn.turn_index;
    }
  }

  return {
    lastTurn,
    activeTargetTable,
    matchedRowIds,
    appliedFilterSummary,
    fromTurnIndex,
  };
}

/**
 * Returns true if the prompt contains anaphoric / follow-up narrowing references
 * referring to previously matched rows.
 */
function hasFollowUpReference(prompt) {
  return FOLLOW_UP_REFERENCE_REGEX.test(String(prompt || ''));
}

/**
 * Returns true if the user explicitly asks to reset / ignore previous filtering scope.
 */
function hasExplicitScopeReset(prompt) {
  return SCOPE_RESET_REGEX.test(String(prompt || ''));
}

/**
 * Formats normalized 5-turn sliding history into a structured prompt context block.
 */
function formatConversationHistoryForPrompt(normalizedHistory = []) {
  const list = Array.isArray(normalizedHistory) ? normalizedHistory.slice(-MAX_CONVERSATION_TURNS) : [];
  if (list.length === 0) return '';

  return JSON.stringify(
    list.map((t) => ({
      turn_index: t.turn_index,
      user_prompt: t.user_prompt,
      resolved_intent: t.resolved_intent || undefined,
      target_table: t.target_table || undefined,
      matched_row_count: Array.isArray(t.matched_row_ids) ? t.matched_row_ids.length : 0,
      matched_row_ids: Array.isArray(t.matched_row_ids) && t.matched_row_ids.length > 0
        ? t.matched_row_ids.slice(0, 40)
        : undefined,
      applied_filter_summary: t.applied_filter_summary || undefined,
      assistant_response_summary: t.assistant_response_summary || undefined,
    })),
    null,
    2
  );
}

/**
 * Resolves the exact column name in `schema` that holds the given prior matched IDs
 * (supporting UUID `id`, business primary keys like `Order_ID`/`account_id`/`unit_id`, or `name`),
 * querying live DB matches only when needed.
 *
 * @param {object} schema
 * @param {string} businessId
 * @param {string[]} matchedRowIds
 * @param {Function} queryFn - db.query function
 * @param {Function} quoteIdentifierFn
 * @returns {Promise<{ field: string, operator: 'in', value: string[] } | null>}
 */
async function resolveIdentifierFilterForIds(
  schema,
  businessId,
  matchedRowIds = [],
  queryFn,
  quoteIdentifierFn
) {
  if (!schema || !schema.columns || !Array.isArray(matchedRowIds) || matchedRowIds.length === 0) {
    return null;
  }

  const cleanIds = [...new Set(matchedRowIds.map((v) => String(v || '').trim()).filter(Boolean))];
  if (cleanIds.length === 0) return null;

  const cols = Object.values(schema.columns);
  const idCol = cols.find((c) => c.exactName.toLowerCase() === 'id');
  if (cleanIds.every((id) => UUID_REGEX.test(id)) && idCol) {
    return { field: idCol.exactName, operator: 'in', value: cleanIds };
  }

  const candidateCols = [];
  const pushCandidate = (col) => {
    if (col && !candidateCols.some((c) => c.exactName === col.exactName)) {
      candidateCols.push(col);
    }
  };

  if (schema.primaryKey) {
    const pkCol = cols.find(
      (c) => c.exactName.toLowerCase() === String(schema.primaryKey).toLowerCase()
    );
    pushCandidate(pkCol);
  }

  for (const col of cols) {
    const lower = col.exactName.toLowerCase();
    if (
      lower !== 'id' &&
      !['business_id', 'workspace_id', 'user_id', 'workspace_document_id'].includes(lower) &&
      !lower.includes('batch') &&
      /(?:^|_)(?:order_id|account_id|backorder_id|customer_id|invoice_id|unit_id|ticket_id|shipment_id|record_id|row_id|id|sku|code|ref|reference|name|title)(?:$|_)/i.test(
        lower
      )
    ) {
      pushCandidate(col);
    }
  }
  pushCandidate(idCol);

  if (candidateCols.length === 0) return null;
  if (candidateCols.length === 1 || typeof queryFn !== 'function' || !businessId) {
    return { field: candidateCols[0].exactName, operator: 'in', value: cleanIds };
  }

  const safeTable = quoteIdentifierFn(schema.tableName);
  const whereBiz = schema.columns.workspace_id
    ? '(business_id = $1 OR workspace_id = $1)'
    : 'business_id = $1';
  const lowerIds = cleanIds.map((id) => id.toLowerCase());

  for (const col of candidateCols) {
    if (!['string', 'uuid', 'integer', 'number', 'numeric'].includes(col.type) && col.exactName.toLowerCase() !== 'id') {
      continue;
    }
    const safeCol = quoteIdentifierFn(col.exactName);
    try {
      const res = await queryFn(
        `SELECT COUNT(*)::int AS cnt FROM ${safeTable} WHERE ${whereBiz} AND LOWER(CAST(${safeCol} AS TEXT)) = ANY($2::text[])`,
        [businessId, lowerIds]
      );
      if (Number(res?.rows?.[0]?.cnt || 0) > 0) {
        return { field: col.exactName, operator: 'in', value: cleanIds };
      }
    } catch {
      // Skip incompatible column casts
    }
  }

  return { field: candidateCols[0].exactName, operator: 'in', value: cleanIds };
}

module.exports = {
  MAX_CONVERSATION_TURNS,
  normalizeConversationHistory,
  getLatestActiveContext,
  hasFollowUpReference,
  hasExplicitScopeReset,
  formatConversationHistoryForPrompt,
  resolveIdentifierFilterForIds,
};
