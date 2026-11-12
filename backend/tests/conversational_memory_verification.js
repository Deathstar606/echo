/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const app = require('../src/app');
const { query, getPool } = require('../db');
const { clearWorkflowStoreGlobal } = require('../src/services/socraticOperationsService');
const { normalizeConversationHistory } = require('../src/utils/conversationHistory');

const WS1 = '11111111-2222-3333-4444-555555555555'; // Echo Demo Operations Workspace
const WS2 = '684a8863-5094-4c8b-9b15-c50c06335b7f'; // Veloura Apparel
const WS3 = 'd47544a4-6e80-41bb-9ddf-e694c714b4fe'; // Veloura Wholesale B2B Accounts Workspace
const WS4 = '52e50e84-197e-41f0-ba30-4bdeeabafa5e'; // Hospital Management Demo Workspace

const OUT_PATH = path.resolve(__dirname, 'conversational_memory_results.json');

const report = {
  started_at: new Date().toISOString(),
  workspaces: {},
};
const failures = [];

function check(scope, cond, message) {
  if (!report.workspaces[scope]) {
    report.workspaces[scope] = { turns: [], checks: [] };
  }
  report.workspaces[scope].checks.push({ ok: Boolean(cond), message });
  if (!cond) {
    failures.push(`[${scope}] ${message}`);
  }
  console.log(`  ${cond ? 'PASS' : 'FAIL'} - ${message}`);
}

async function jsonReq(base, method, route, body) {
  const t0 = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if ((res.status === 502 || res.status === 503) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    return { status: res.status, data, ms: Date.now() - t0 };
  }
}

function summarizeFilters(interpretedQuery) {
  const filters = Array.isArray(interpretedQuery?.filters) ? interpretedQuery.filters : [];
  if (filters.length === 0) return '';
  const logic = String(interpretedQuery?.filter_logic || 'AND').toUpperCase();
  return filters
    .map((f) => `${f.field || f.column} ${f.operator} ${JSON.stringify(f.value)}`)
    .join(` ${logic} `);
}

function extractIdsFromResponse(payload, fallbackRows = []) {
  if (Array.isArray(payload?.highlighted_rows) && payload.highlighted_rows.length > 0) {
    return payload.highlighted_rows.map((h) => String(h.row_identifier || '').trim()).filter(Boolean);
  }
  if (Array.isArray(payload?.matched_ids) && payload.matched_ids.length > 0) {
    return payload.matched_ids.map((id) => String(id).trim()).filter(Boolean);
  }
  if (Array.isArray(payload?.matched_row_ids) && payload.matched_row_ids.length > 0) {
    return payload.matched_row_ids.map((id) => String(id).trim()).filter(Boolean);
  }
  if (Array.isArray(payload?.diff) && payload.diff.length > 0) {
    return payload.diff.map((d) => String(d.row_identifier || d.id || '').trim()).filter(Boolean);
  }
  if (Array.isArray(payload?.mutations_preview) && payload.mutations_preview.length > 0) {
    return payload.mutations_preview.map((m) => String(m.row_identifier || '').trim()).filter(Boolean);
  }
  if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
    return fallbackRows.map((r) => String(r?.id || '').trim()).filter(Boolean);
  }
  return [];
}

/**
 * Simulates exact frontend SocraticOperationsWorkbench + SheetManagementPanel behavior
 * for a conversational turn, maintaining and slicing the 5-turn sliding window.
 */
async function runUiEquivalentTurn(base, scope, { businessId, prompt, activeEntity = null, history }) {
  const windowHistory = history.slice(-5);
  const execRes = await jsonReq(base, 'POST', '/api/workspace/execute', {
    business_id: businessId,
    prompt,
    entity: 'user',
    ...(activeEntity ? { table_name: activeEntity } : {}),
    conversation_history: windowHistory,
    history: windowHistory,
  });

  if (execRes.status >= 400) {
    throw new Error(`HTTP ${execRes.status} from /api/workspace/execute: ${JSON.stringify(execRes.data)}`);
  }

  let finalPayload = execRes.data;
  let routedActionPayload = null;
  let resolvedIntent = String(execRes.data?.status || 'UNKNOWN');
  let targetTable = execRes.data?.entity || execRes.data?.target_entity || activeEntity || null;
  let matchedRowIds = [];
  let filterSummary = '';
  let assistantSummary = String(execRes.data?.answer || execRes.data?.message || '').slice(0, 400);

  if (execRes.data?.status === 'SHEET_QUERY' && Array.isArray(execRes.data?.rows)) {
    matchedRowIds = extractIdsFromResponse(execRes.data, execRes.data.rows);
    filterSummary = summarizeFilters(execRes.data.interpretedQuery);
  } else if (execRes.data?.status === 'SHEET_QUERY') {
    const qRes = await jsonReq(
      base,
      'POST',
      `/api/businesses/${encodeURIComponent(businessId)}/sheets/query`,
      {
        entity: execRes.data.entity || activeEntity || 'products',
        message: prompt,
        conversation_history: windowHistory,
      }
    );
    if (qRes.status >= 400) {
      throw new Error(`HTTP ${qRes.status} from /sheets/query: ${JSON.stringify(qRes.data)}`);
    }
    routedActionPayload = qRes.data;
    finalPayload = qRes.data;
    targetTable = qRes.data.entity || execRes.data.entity || targetTable;
    matchedRowIds = extractIdsFromResponse(qRes.data, qRes.data.rows);
    filterSummary = summarizeFilters(qRes.data.interpretedQuery);
    assistantSummary = String(qRes.data.answer || qRes.data.message || '').slice(0, 400);
  } else if (execRes.data?.status === 'SHEET_MUTATION') {
    const mRes = await jsonReq(
      base,
      'POST',
      `/api/sheets/mutation?businessId=${encodeURIComponent(businessId)}`,
      {
        business_id: businessId,
        entity: execRes.data.entity || activeEntity || 'products',
        message: prompt,
        confirm: false,
        conversation_history: windowHistory,
      }
    );
    if (mRes.status >= 400) {
      throw new Error(`HTTP ${mRes.status} from /sheets/mutation: ${JSON.stringify(mRes.data)}`);
    }
    routedActionPayload = mRes.data;
    finalPayload = mRes.data;
    targetTable = mRes.data.entity || execRes.data.entity || targetTable;
    matchedRowIds = extractIdsFromResponse(mRes.data, mRes.data.target_rows);
    assistantSummary = String(mRes.data.message || '').slice(0, 400);
  } else if (execRes.data?.status === 'CONVERSATIONAL') {
    resolvedIntent = execRes.data.intent === 'cross_source_read' ? 'CROSS_SOURCE_READ' : 'CONVERSATIONAL';
    targetTable =
      execRes.data.highlighted_rows?.[0]?.table_name ||
      execRes.data.rows?.[0]?.table_name ||
      targetTable;
    matchedRowIds = extractIdsFromResponse(execRes.data, execRes.data.rows);
  } else if (
    execRes.data?.status === 'CLARIFICATION_REQUIRED' ||
    execRes.data?.status === 'PREVIEW_READY'
  ) {
    resolvedIntent = 'CROSS_DOCUMENT_OPERATION';
    targetTable =
      execRes.data.target_entity ||
      execRes.data.mutations_preview?.[0]?.table_name ||
      targetTable;
    matchedRowIds = extractIdsFromResponse(execRes.data);
    assistantSummary =
      execRes.data.conflict_summary ||
      `Prepared Socratic preview for ${matchedRowIds.length} row(s).`;
  }

  const nextTurnIndex =
    history.length > 0 ? Number(history[history.length - 1].turn_index || history.length) + 1 : 1;
  const turnRecord = {
    turn_index: nextTurnIndex,
    user_prompt: prompt,
    resolved_intent: resolvedIntent,
    target_table: targetTable,
    matched_row_ids: matchedRowIds,
    applied_filter_summary: filterSummary,
    assistant_response_summary: assistantSummary,
  };
  history.push(turnRecord);

  if (!report.workspaces[scope]) {
    report.workspaces[scope] = { turns: [], checks: [] };
  }
  report.workspaces[scope].turns.push({
    turn_index: nextTurnIndex,
    prompt,
    sent_history_length: windowHistory.length,
    execute_status: execRes.data?.status,
    routed_status: routedActionPayload?.status || null,
    target_table: targetTable,
    matched_row_ids: matchedRowIds,
    ms: execRes.ms,
  });

  return {
    executeResponse: execRes.data,
    routedResponse: routedActionPayload,
    finalPayload,
    turnRecord,
  };
}

async function captureBaselineHashes() {
  const tables = [
    ['orders', WS1],
    ['products', WS2],
    ['wholesale_accunts_dataset', WS3],
    ['hospital_units', WS4],
  ];
  const counts = {};
  for (const [tbl, biz] of tables) {
    const res = await query(`SELECT COUNT(*)::int AS cnt FROM "${tbl}" WHERE business_id = $1`, [biz]);
    counts[`${biz}:${tbl}`] = res.rows[0].cnt;
  }
  return counts;
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  console.log(`Test server listening at ${base}`);

  const baselineCounts = await captureBaselineHashes();
  report.baseline_counts = baselineCounts;

  try {
    // 0. Deterministic sliding-window unit sanity check (>5 turns -> keep 5 most recent)
    {
      console.log('\n=== UNIT: 5-Turn Sliding Window Normalization ===');
      const sevenTurns = Array.from({ length: 7 }, (_, i) => ({
        turn_index: i + 1,
        user_prompt: `Turn prompt ${i + 1}`,
        resolved_intent: 'SHEET_QUERY',
        target_table: 'orders',
        matched_row_ids: [`ID-${i + 1}`],
        applied_filter_summary: `col = ${i + 1}`,
        assistant_response_summary: `Found ID-${i + 1}`,
      }));
      const sliced = normalizeConversationHistory(sevenTurns);
      check('sliding_window', sliced.length === 5, `7 turns normalize strictly to length 5 (got ${sliced.length})`);
      check(
        'sliding_window',
        sliced[0].turn_index === 3 && sliced[4].turn_index === 7,
        `Keeps turns 3..7 and drops turns 1..2 (got ${sliced.map((t) => t.turn_index).join(', ')})`
      );
    }

    // 1. Workspace 1 — Echo Demo Operations Workspace (orders.csv)
    {
      console.log('\n=== WS1: Echo Demo Operations Workspace (3-Turn Read -> Filter -> Preview) ===');
      await clearWorkflowStoreGlobal();
      const history = [];

      const t1 = await runUiEquivalentTurn(base, 'ws1_echo_demo', {
        businessId: WS1,
        prompt: 'Find all orders in orders.csv that are currently Delayed and have Delay_Hours >= 48.',
        history,
      });
      check(
        'ws1_echo_demo',
        t1.turnRecord.target_table === 'orders',
        `Turn 1 resolved target_table="orders" (got ${t1.turnRecord.target_table})`
      );
      check(
        'ws1_echo_demo',
        ['ORD-2026-1026', 'ORD-2026-1027', 'ORD-2026-1030'].every((id) =>
          t1.turnRecord.matched_row_ids.includes(id)
        ),
        `Turn 1 matched Delayed orders >=48h including ORD-2026-1026, ORD-2026-1027, ORD-2026-1030 (got ${JSON.stringify(t1.turnRecord.matched_row_ids)})`
      );

      const t2 = await runUiEquivalentTurn(base, 'ws1_echo_demo', {
        businessId: WS1,
        prompt: 'Now filter those to only the ones where SLA_Voucher_Issued is False.',
        history,
      });
      const t2Ids = [...t2.turnRecord.matched_row_ids].sort();
      check(
        'ws1_echo_demo',
        t2.turnRecord.target_table === 'orders',
        `Turn 2 inherited target_table="orders" with no table named in prompt (got ${t2.turnRecord.target_table})`
      );
      check(
        'ws1_echo_demo',
        JSON.stringify(t2Ids) === JSON.stringify(['ORD-2026-1026', 'ORD-2026-1027', 'ORD-2026-1030']),
        `Turn 2 chained filter narrowed cleanly to ORD-2026-1026, ORD-2026-1027, ORD-2026-1030 (got ${JSON.stringify(t2Ids)})`
      );

      const t3 = await runUiEquivalentTurn(base, 'ws1_echo_demo', {
        businessId: WS1,
        prompt: 'Update those orders to set SLA_Voucher_Issued to True and Shipping_Tier to Expedited.',
        history,
      });
      const t3Preview = t3.finalPayload;
      const t3OrderIds = (t3Preview?.target_rows || []).map((r) => r.Order_ID || r.order_id).sort();
      check(
        'ws1_echo_demo',
        t3Preview?.status === 'preview',
        `Turn 3 returned Stage 1 mutation preview without false clarification (got ${t3Preview?.status}: ${t3Preview?.message || ''})`
      );
      check(
        'ws1_echo_demo',
        t3Preview?.affected_count === 3 &&
          JSON.stringify(t3OrderIds) === JSON.stringify(['ORD-2026-1026', 'ORD-2026-1027', 'ORD-2026-1030']),
        `Turn 3 scoped Stage 1 preview to exact 3 orders from Turn 2 (got ${t3Preview?.affected_count}: ${JSON.stringify(t3OrderIds)})`
      );
      const allDiffsValid = (t3Preview?.diff || []).every(
        (d) => d.after?.SLA_Voucher_Issued === true && d.after?.Shipping_Tier === 'Expedited'
      );
      check(
        'ws1_echo_demo',
        allDiffsValid && (t3Preview?.diff || []).length === 3,
        'Turn 3 preview diffs set SLA_Voucher_Issued=true and Shipping_Tier="Expedited" on all 3 rows'
      );
    }

    // 2. Workspace 2 — Veloura Apparel (products.csv + Reset Test)
    {
      console.log('\n=== WS2: Veloura Apparel (Prompt -> Scoped Preview -> Reset Safeguard) ===');
      await clearWorkflowStoreGlobal();
      const history = [];

      const t1 = await runUiEquivalentTurn(base, 'ws2_veloura', {
        businessId: WS2,
        prompt: 'Show me the products with discount more than 10%.',
        activeEntity: 'products',
        history,
      });
      const t1Rows = t1.finalPayload?.rows || [];
      const t1Uuids = t1Rows.map((r) => r.id).filter(Boolean).sort();
      check(
        'ws2_veloura',
        t1.turnRecord.target_table === 'products' && t1Rows.length > 0 && t1Rows.every((r) => Number(r.discount) > 10),
        `Turn 1 returned ${t1Rows.length} products in "products" with discount > 10`
      );

      const t2 = await runUiEquivalentTurn(base, 'ws2_veloura', {
        businessId: WS2,
        prompt: 'Increase the discount to 20%.',
        activeEntity: 'products',
        history,
      });
      const t2Preview = t2.finalPayload;
      const t2Uuids = (t2Preview?.target_rows || []).map((r) => r.id).filter(Boolean).sort();
      check(
        'ws2_veloura',
        t2Preview?.status === 'preview',
        `Turn 2 produced Stage 1 preview using Turn 1 scope with ZERO clarification_needed (got ${t2Preview?.status})`
      );
      check(
        'ws2_veloura',
        t2Preview?.affected_count === t1Rows.length &&
          JSON.stringify(t2Uuids) === JSON.stringify(t1Uuids),
        `Turn 2 preview targets exact same ${t1Rows.length} Turn 1 rows (got ${t2Preview?.affected_count})`
      );
      check(
        'ws2_veloura',
        (t2Preview?.diff || []).every((d) => Number(d.after?.discount) === 20),
        'Turn 2 preview diffs update discount to 20'
      );

      // Reset Test: Clear conversation history to [] and re-run unscoped prompt
      const resetHistory = [];
      const postResetRes = await runUiEquivalentTurn(base, 'ws2_veloura', {
        businessId: WS2,
        prompt: 'Increase the discount to 20%.',
        activeEntity: 'products',
        history: resetHistory,
      });
      const postResetStatus = postResetRes.finalPayload?.status;
      check(
        'ws2_veloura',
        postResetStatus === 'clarification_needed' ||
          postResetRes.finalPayload?.intent === 'clarification_needed',
        `Post-Reset with empty history preserves safeguard and requires clarification (got status=${postResetStatus}, intent=${postResetRes.finalPayload?.intent})`
      );
      check(
        'ws2_veloura',
        Number(postResetRes.finalPayload?.affected_count || 0) === 0,
        'Post-Reset refuses to preview or mutate any rows'
      );
    }

    // 3. Workspace 3 — Veloura Wholesale B2B Accounts Workspace (Read -> Filter -> Cross-Document Socratic)
    {
      console.log('\n=== WS3: Veloura Wholesale B2B (Read -> Filter -> Cross-Doc Q4 VIP Brief) ===');
      await clearWorkflowStoreGlobal();
      const history = [];

      const t1 = await runUiEquivalentTurn(base, 'ws3_wholesale', {
        businessId: WS3,
        prompt: 'Show me the Gold tier wholesale accounts in wholesale_accunts_dataset.csv.',
        history,
      });
      const t1Rows = t1.finalPayload?.rows || [];
      check(
        'ws3_wholesale',
        t1.turnRecord.target_table === 'wholesale_accunts_dataset' &&
          t1Rows.length > 0 &&
          t1Rows.every((r) => String(r.current_tier).toLowerCase() === 'gold'),
        `Turn 1 returned ${t1Rows.length} Gold tier rows from wholesale_accunts_dataset`
      );

      const t2 = await runUiEquivalentTurn(base, 'ws3_wholesale', {
        businessId: WS3,
        prompt: 'Filter those to accounts with annual_spend >= 50000 and overdue_balance = 0.',
        history,
      });
      const t2Ids = [...t2.turnRecord.matched_row_ids].sort();
      check(
        'ws3_wholesale',
        t2.turnRecord.target_table === 'wholesale_accunts_dataset' &&
          JSON.stringify(t2Ids) === JSON.stringify(['ACC-1017', 'ACC-1018']),
        `Turn 2 narrowed Gold accounts strictly to ACC-1017 & ACC-1018 (got ${JSON.stringify(t2Ids)})`
      );

      const t3 = await runUiEquivalentTurn(base, 'ws3_wholesale', {
        businessId: WS3,
        prompt: 'Upgrade those accounts to Platinum, increase their credit limit by 30% per the Q4 VIP Expansion Brief, and email the account managers.',
        history,
      });
      const t3Payload = t3.finalPayload;
      let previewMutations = t3Payload?.mutations_preview || [];
      if (t3Payload?.status === 'CLARIFICATION_REQUIRED') {
        const q = t3Payload.socratic_questions?.[0];
        const opt = q?.options?.[0];
        if (q && opt) {
          const resolveRes = await jsonReq(base, 'POST', '/api/workspace/resolve-socratic', {
            business_id: WS3,
            workflow_id: t3Payload.workflow_id,
            selected_options: { [q.question_id]: opt.option_id },
          });
          previewMutations = resolveRes.data?.mutations_preview || [];
        }
      }
      const previewRowIds = previewMutations
        .map((m) => String(m.row_identifier || '').trim())
        .sort();
      check(
        'ws3_wholesale',
        ['PREVIEW_READY', 'CLARIFICATION_REQUIRED'].includes(t3Payload?.status),
        `Turn 3 entered cross-document Socratic pipeline cleanly (got ${t3Payload?.status})`
      );
      check(
        'ws3_wholesale',
        JSON.stringify(previewRowIds) === JSON.stringify(['ACC-1017', 'ACC-1018']) ||
          JSON.stringify([...t3.turnRecord.matched_row_ids].sort()) === JSON.stringify(['ACC-1017', 'ACC-1018']),
        `Turn 3 scoped strictly to ACC-1017 & ACC-1018 (got matched=${JSON.stringify(t3.turnRecord.matched_row_ids)}, preview=${JSON.stringify(previewRowIds)})`
      );
    }

    // 4. Workspace 4 — Hospital Management Demo Workspace (hospital_units.csv + 6-Turn Sliding Window live test)
    {
      console.log('\n=== WS4: Hospital Management (Read -> Filter -> Implicit Mutate + 6-Turn Live Window) ===');
      await clearWorkflowStoreGlobal();
      const history = [];

      const t1 = await runUiEquivalentTurn(base, 'ws4_hospital', {
        businessId: WS4,
        prompt: 'Show me all Adult ICU units in hospital_units.csv with at least 2 clean beds.',
        history,
      });
      check(
        'ws4_hospital',
        t1.turnRecord.target_table === 'hospital_units' &&
          t1.turnRecord.matched_row_ids.includes('HICU-04'),
        `Turn 1 matched Adult ICU / ICU units with clean_beds >= 2 including HICU-04 (got ${JSON.stringify(t1.turnRecord.matched_row_ids)})`
      );

      const t2 = await runUiEquivalentTurn(base, 'ws4_hospital', {
        businessId: WS4,
        prompt: 'Filter those to the ones with zero staffing_gap.',
        history,
      });
      check(
        'ws4_hospital',
        t2.turnRecord.target_table === 'hospital_units' &&
          JSON.stringify(t2.turnRecord.matched_row_ids) === JSON.stringify(['HICU-04']),
        `Turn 2 narrowed cleanly to HICU-04 (got ${JSON.stringify(t2.turnRecord.matched_row_ids)})`
      );

      const t3 = await runUiEquivalentTurn(base, 'ws4_hospital', {
        businessId: WS4,
        prompt: "Update the surge_status of that unit to 'Surge Ready'.",
        history,
      });
      const t3Preview = t3.finalPayload;
      const t3UnitIds = (t3Preview?.target_rows || []).map((r) => r.unit_id);
      check(
        'ws4_hospital',
        t3Preview?.status === 'preview' &&
          t3Preview?.affected_count === 1 &&
          JSON.stringify(t3UnitIds) === JSON.stringify(['HICU-04']) &&
          t3Preview?.diff?.[0]?.after?.surge_status === 'Surge Ready',
        `Turn 3 resolved "that unit" -> 1-row mutation preview for HICU-04 surge_status="Surge Ready" (got status=${t3Preview?.status}, ids=${JSON.stringify(t3UnitIds)})`
      );

      // Additional Turns 4..6 to exercise live 5-turn sliding window cap
      await runUiEquivalentTurn(base, 'ws4_hospital', {
        businessId: WS4,
        prompt: 'Show me all NICU units in hospital_units.csv.',
        history,
      });
      await runUiEquivalentTurn(base, 'ws4_hospital', {
        businessId: WS4,
        prompt: 'Show me all Medical department units in hospital_units.csv.',
        history,
      });
      const t6 = await runUiEquivalentTurn(base, 'ws4_hospital', {
        businessId: WS4,
        prompt: 'Filter those to units in West Wing.',
        history,
      });
      check(
        'ws4_hospital',
        report.workspaces.ws4_hospital.turns[5].sent_history_length === 5 &&
          t6.turnRecord.matched_row_ids.includes('HWARD-01'),
        `Turn 6 sent capped history length=5 (dropped Turn 1) and filtered prior Turn 5 Medical units in West Wing -> HWARD-01 (got ${JSON.stringify(t6.turnRecord.matched_row_ids)})`
      );
    }

    // Verify ZERO baseline table rows were mutated
    const finalCounts = await captureBaselineHashes();
    const unchanged = JSON.stringify(baselineCounts) === JSON.stringify(finalCounts);
    check(
      'baseline_integrity',
      unchanged,
      `All 4 workspace table row counts remain untouched (${JSON.stringify(finalCounts)})`
    );

    report.finished_at = new Date().toISOString();
    report.passed = failures.length === 0;
    report.failures = failures;
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');

    console.log(`\nSaved verification report to ${OUT_PATH}`);
    if (failures.length > 0) {
      console.error(`\nFAILED CHECKS (${failures.length}):\n - ${failures.join('\n - ')}`);
      process.exitCode = 1;
    } else {
      console.log('\nALL CONVERSATIONAL MEMORY & SCOPE INHERITANCE CHECKS PASSED.');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const pool = getPool();
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
