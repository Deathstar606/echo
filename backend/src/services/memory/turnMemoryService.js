const { query } = require('../../../db');
const { isLivePostgresPool } = require('../rag/embeddingService');

const MAX_MEMORY_TURNS = 5;
const MAX_MEMORY_TOKENS = 600;
const MAX_TURN_TOKENS = 120;
const MAX_ROW_KEYS_PER_TURN = 25;

// Deterministic in-memory fallback store used ONLY when running against unit-test mock pools
// that do not implement workspace_turn_memory.
const FALLBACK_MEMORY_BY_SESSION = new Map();

function estimateTokenCount(text) {
  const clean = String(text || '').trim();
  if (!clean) return 0;
  return Math.ceil(clean.length / 4);
}

function compactRowKeys(rowKeys = [], maxKeys = MAX_ROW_KEYS_PER_TURN) {
  if (!Array.isArray(rowKeys) || rowKeys.length === 0) return [];
  const unique = [];
  const seen = new Set();
  for (const raw of rowKeys) {
    const val = String(raw ?? '').trim();
    if (!val || /^\+\d+\s+more$/i.test(val)) continue;
    const key = val.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(val.slice(0, 64));
    }
  }
  if (unique.length <= maxKeys) return unique;
  return [...unique.slice(0, maxKeys), `+${unique.length - maxKeys} more`];
}

function compactStringList(items = [], maxItems = 6, maxItemLen = 60) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const unique = [];
  const seen = new Set();
  for (const raw of items) {
    const val = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!val) continue;
    const truncated = val.length > maxItemLen ? `${val.slice(0, maxItemLen - 3)}...` : val;
    const key = truncated.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(truncated);
      if (unique.length >= maxItems) break;
    }
  }
  return unique;
}

function trimToChars(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function formatTurnLine(turn, maxLineTokens = MAX_TURN_TOKENS) {
  const tables = Array.isArray(turn.touched_tables) ? turn.touched_tables : [];
  const rawKeys = Array.isArray(turn.touched_row_keys) ? turn.touched_row_keys : [];
  const docs = Array.isArray(turn.touched_doc_citations) ? turn.touched_doc_citations : [];

  const render = (intent, action, keysList, docsList, outcome) => {
    const parts = [
      `[Turn ${turn.turn_number}]`,
      `Intent: ${intent}`,
      `Action: ${action}`,
    ];
    if (tables.length > 0) parts.push(`Tables: ${tables.join(',')}`);
    if (keysList.length > 0) parts.push(`Keys: ${keysList.join(',')}`);
    if (docsList.length > 0) parts.push(`Docs: ${docsList.join(',')}`);
    parts.push(`Outcome: ${outcome}`);
    return parts.join(' | ');
  };

  let intent = turn.user_intent_summary || '';
  let action = turn.action_taken || '';
  let keysSlice = rawKeys;
  let docsSlice = docs;
  let outcome = turn.outcome_summary || '';

  let line = render(intent, action, keysSlice, docsSlice, outcome);
  if (estimateTokenCount(line) <= maxLineTokens) {
    return line;
  }

  outcome = trimToChars(outcome, 70);
  intent = trimToChars(intent, 55);
  action = trimToChars(action, 45);
  docsSlice = docsSlice.slice(0, 1);
  line = render(intent, action, keysSlice, docsSlice, outcome);

  if (estimateTokenCount(line) > maxLineTokens && rawKeys.length > 8) {
    const nonOverflow = rawKeys.filter((k) => !/^\+\d+\s+more$/i.test(k));
    const overflowItem = rawKeys.find((k) => /^\+\d+\s+more$/i.test(k));
    const extraCount = overflowItem
      ? Number.parseInt(overflowItem.replace(/[^\d]/g, ''), 10) || 0
      : 0;
    const kept = nonOverflow.slice(0, 8);
    const totalHidden = extraCount + Math.max(0, nonOverflow.length - 8);
    keysSlice = totalHidden > 0 ? [...kept, `+${totalHidden} more`] : kept;
    line = render(intent, action, keysSlice, docsSlice, outcome);
  }

  if (estimateTokenCount(line) > maxLineTokens) {
    line = trimToChars(line, maxLineTokens * 4);
  }
  return line;
}

function enforceSingleTurnTokenCap(record, maxTokens = MAX_TURN_TOKENS) {
  const next = {
    ...record,
    user_intent_summary: trimToChars(record.user_intent_summary, 110) || 'workspace request',
    action_taken: trimToChars(record.action_taken, 80) || 'EXECUTED',
    touched_tables: compactStringList(record.touched_tables, 5, 48),
    // Always preserve up to 25 exact row keys (+ "+N more") in persistent turn state
    touched_row_keys: compactRowKeys(record.touched_row_keys, MAX_ROW_KEYS_PER_TURN),
    touched_doc_citations: compactStringList(record.touched_doc_citations, 4, 48),
    outcome_summary: trimToChars(record.outcome_summary, 180) || 'Completed',
  };

  if (estimateTokenCount(formatTurnLine({ ...next, touched_row_keys: [] })) > maxTokens) {
    next.outcome_summary = trimToChars(next.outcome_summary, 80);
    next.user_intent_summary = trimToChars(next.user_intent_summary, 60);
    next.action_taken = trimToChars(next.action_taken, 50);
    next.touched_doc_citations = next.touched_doc_citations.slice(0, 2);
  }
  return next;
}

/**
 * Records a compact structured turn state (<= 120 estimated tokens/turn, max 25 row keys)
 * into PostgreSQL `workspace_turn_memory` for reliable pronoun & multi-turn resolution.
 */
async function recordTurnState({
  workspaceId,
  sessionId,
  turnNumber = null,
  entity = 'user',
  userIntentSummary,
  actionTaken,
  touchedTables = [],
  touchedRowKeys = [],
  touchedDocCitations = [],
  outcomeSummary,
}) {
  const cleanWs = String(workspaceId || '').trim();
  const cleanSess = String(sessionId || '').trim();
  if (!cleanWs || !cleanSess) {
    return null;
  }

  const normalizedEntity = String(entity || 'user').trim().toLowerCase() === 'customer'
    ? 'customer'
    : 'user';

  const shaped = enforceSingleTurnTokenCap({
    turn_number: Number.isFinite(Number(turnNumber)) ? Number(turnNumber) : 1,
    entity: normalizedEntity,
    user_intent_summary: userIntentSummary,
    action_taken: actionTaken,
    touched_tables: touchedTables,
    touched_row_keys: touchedRowKeys,
    touched_doc_citations: touchedDocCitations,
    outcome_summary: outcomeSummary,
  });

  if (isLivePostgresPool()) {
    try {
      const explicitTurn = Number.isFinite(Number(turnNumber)) ? Number(turnNumber) : null;
      const res = explicitTurn !== null
        ? await query(
            `INSERT INTO workspace_turn_memory
               (workspace_id, session_id, turn_number, entity, user_intent_summary,
                action_taken, touched_tables, touched_row_keys, touched_doc_citations, outcome_summary)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
             RETURNING *;`,
            [
              cleanWs,
              cleanSess,
              explicitTurn,
              shaped.entity,
              shaped.user_intent_summary,
              shaped.action_taken,
              JSON.stringify(shaped.touched_tables),
              JSON.stringify(shaped.touched_row_keys),
              JSON.stringify(shaped.touched_doc_citations),
              shaped.outcome_summary,
            ]
          )
        : await query(
            `INSERT INTO workspace_turn_memory
               (workspace_id, session_id, turn_number, entity, user_intent_summary,
                action_taken, touched_tables, touched_row_keys, touched_doc_citations, outcome_summary)
             VALUES (
               $1,
               $2,
               COALESCE((SELECT MAX(turn_number) FROM workspace_turn_memory WHERE workspace_id = $1 AND session_id = $2), 0) + 1,
               $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9
             )
             RETURNING *;`,
            [
              cleanWs,
              cleanSess,
              shaped.entity,
              shaped.user_intent_summary,
              shaped.action_taken,
              JSON.stringify(shaped.touched_tables),
              JSON.stringify(shaped.touched_row_keys),
              JSON.stringify(shaped.touched_doc_citations),
              shaped.outcome_summary,
            ]
          );
      if (res?.rows?.[0]) {
        return res.rows[0];
      }
    } catch (err) {
      console.warn('[TurnMemory] DB record warning:', err.message);
    }
  }

  const memKey = `${cleanWs}::${cleanSess}`;
  const list = FALLBACK_MEMORY_BY_SESSION.get(memKey) || [];
  const nextTurnNum =
    Number.isFinite(Number(turnNumber))
      ? Number(turnNumber)
      : (list.length > 0 ? list[list.length - 1].turn_number : 0) + 1;
  const fallbackRow = {
    id: `mem-${Date.now()}-${nextTurnNum}`,
    workspace_id: cleanWs,
    session_id: cleanSess,
    ...shaped,
    turn_number: nextTurnNum,
    created_at: new Date().toISOString(),
  };
  list.push(fallbackRow);
  FALLBACK_MEMORY_BY_SESSION.set(memKey, list.slice(-20));
  return fallbackRow;
}

/**
 * Fetches the latest N turns (default 5) in chronological order and enforces a hard
 * total token budget (default <= 600 estimated tokens) by dropping oldest turns first.
 *
 * @param {string} workspaceId
 * @param {string} sessionId
 * @param {number} [maxTurns=5]
 * @param {number} [maxTokens=600]
 */
async function getCompactMemoryWindow(
  workspaceId,
  sessionId,
  maxTurns = MAX_MEMORY_TURNS,
  maxTokens = MAX_MEMORY_TOKENS
) {
  const cleanWs = String(workspaceId || '').trim();
  const cleanSess = String(sessionId || '').trim();
  if (!cleanWs || !cleanSess) {
    return {
      turns: [],
      formattedBlock: '',
      estimatedTokens: 0,
      latestTouchedTables: [],
      latestTouchedRowKeys: [],
    };
  }

  const limitTurns = Math.max(1, Math.min(20, Number(maxTurns) || MAX_MEMORY_TURNS));
  const tokenCap = Math.max(100, Number(maxTokens) || MAX_MEMORY_TOKENS);

  let rawRows = [];
  if (isLivePostgresPool()) {
    try {
      const res = await query(
        `SELECT id, workspace_id, session_id, turn_number, entity, user_intent_summary,
                action_taken, touched_tables, touched_row_keys, touched_doc_citations,
                outcome_summary, created_at
         FROM workspace_turn_memory
         WHERE workspace_id = $1 AND session_id = $2
         ORDER BY turn_number DESC, created_at DESC
         LIMIT $3;`,
        [cleanWs, cleanSess, limitTurns]
      );
      if (Array.isArray(res?.rows)) {
        rawRows = res.rows;
      }
    } catch (err) {
      console.warn('[TurnMemory] DB read warning:', err.message);
    }
  } else {
    const list = FALLBACK_MEMORY_BY_SESSION.get(`${cleanWs}::${cleanSess}`) || [];
    rawRows = list.slice(-limitTurns).reverse();
  }

  const chronological = [...rawRows].reverse().map((row) => ({
    ...row,
    touched_tables: Array.isArray(row.touched_tables) ? row.touched_tables : [],
    touched_row_keys: Array.isArray(row.touched_row_keys) ? row.touched_row_keys : [],
    touched_doc_citations: Array.isArray(row.touched_doc_citations)
      ? row.touched_doc_citations
      : [],
  }));

  // Enforce hard token budget by dropping oldest turns first
  const keptTurns = [...chronological];
  let lines = keptTurns.map((t) => formatTurnLine(t));
  let formattedBlock = lines.join('\n');
  let estimatedTokens = estimateTokenCount(formattedBlock);

  while (estimatedTokens > tokenCap && keptTurns.length > 1) {
    keptTurns.shift();
    lines = keptTurns.map((t) => formatTurnLine(t));
    formattedBlock = lines.join('\n');
    estimatedTokens = estimateTokenCount(formattedBlock);
  }

  if (estimatedTokens > tokenCap && keptTurns.length === 1) {
    formattedBlock = formattedBlock.slice(0, tokenCap * 4);
    estimatedTokens = estimateTokenCount(formattedBlock);
  }

  let latestTouchedTables = [];
  let latestTouchedRowKeys = [];
  for (let i = keptTurns.length - 1; i >= 0; i -= 1) {
    const t = keptTurns[i];
    if (latestTouchedTables.length === 0 && t.touched_tables.length > 0) {
      latestTouchedTables = t.touched_tables;
    }
    if (latestTouchedRowKeys.length === 0 && t.touched_row_keys.length > 0) {
      latestTouchedRowKeys = t.touched_row_keys.filter((k) => !/^\+\d+\s+more$/i.test(k));
    }
    if (latestTouchedTables.length > 0 && latestTouchedRowKeys.length > 0) {
      break;
    }
  }

  return {
    turns: keptTurns,
    formattedBlock,
    estimatedTokens,
    latestTouchedTables,
    latestTouchedRowKeys,
  };
}

/**
 * Deletes stored turn state rows for a workspace session (e.g., evaluation teardown).
 */
async function clearSessionMemory(workspaceId, sessionId) {
  const cleanWs = String(workspaceId || '').trim();
  const cleanSess = String(sessionId || '').trim();
  if (!cleanWs || !cleanSess) return { deleted: 0 };

  FALLBACK_MEMORY_BY_SESSION.delete(`${cleanWs}::${cleanSess}`);
  if (isLivePostgresPool()) {
    try {
      const res = await query(
        `DELETE FROM workspace_turn_memory WHERE workspace_id = $1 AND session_id = $2;`,
        [cleanWs, cleanSess]
      );
      return { deleted: Number(res?.rowCount || 0) };
    } catch {
      return { deleted: 0 };
    }
  }
  return { deleted: 0 };
}

module.exports = {
  MAX_MEMORY_TURNS,
  MAX_MEMORY_TOKENS,
  MAX_TURN_TOKENS,
  MAX_ROW_KEYS_PER_TURN,
  estimateTokenCount,
  compactRowKeys,
  formatTurnLine,
  recordTurnState,
  getCompactMemoryWindow,
  clearSessionMemory,
};
