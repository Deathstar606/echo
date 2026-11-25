require('dotenv').config();

const assert = require('node:assert/strict');
const { query, getPool } = require('../db');
const {
  estimateTokens,
  enforceTokenBudget,
} = require('../src/services/llm/tokenBudgetService');
const {
  OPS_ANALYST_SYSTEM_PROMPT,
  CUSTOMER_CARE_SYSTEM_PROMPT,
  buildCacheOrderedPrompt,
} = require('../src/services/llm/promptTemplates');
const {
  ReActStepSchema,
} = require('../src/services/llm/schemas');
const {
  invokeStructuredLLM,
} = require('../src/services/llm/structuredOutputService');
const {
  verifyCitations,
} = require('../src/services/rag/crossRagService');
const {
  getToolDefinitionsForEntity,
} = require('../src/services/operations/toolRegistry');
const {
  executeWorkspaceOperation,
  confirmWorkspaceOperation,
  resolveSocraticWorkflow,
} = require('../src/services/operations/socraticOperationsService');
const {
  generateWorkspaceCustomerReply,
} = require('../src/services/operations/workspaceReplyService');
const { findBusinessOrThrow } = require('../src/controllers/businessController');
const { clearSessionMemory } = require('../src/services/memory/turnMemoryService');

const WS_ORDER_MGMT = '11111111-2222-3333-4444-555555555555';
const WS_VELOURA = '684a8863-5094-4c8b-9b15-c50c06335b7f';
const WS_WHOLESALE = 'd47544a4-6e80-41bb-9ddf-e694c714b4fe';
const WS_MEDICAL = '52e50e84-197e-41f0-ba30-4bdeeabafa5e';
const WS_RBS = 'b662ec3e-9f40-4c62-874a-af2a88a87317';

const ALL_WORKSPACES = [
  WS_ORDER_MGMT,
  WS_VELOURA,
  WS_WHOLESALE,
  WS_MEDICAL,
  WS_RBS,
];

function avg(nums = []) {
  if (!nums.length) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

async function captureDbBaselineSnapshot() {
  const tableCounts = await query(`
    SELECT 'orders' AS tbl, COUNT(*)::int AS cnt FROM orders
    UNION ALL SELECT 'warehouse_inventory_batches', COUNT(*)::int FROM warehouse_inventory_batches
    UNION ALL SELECT 'backorders_dataset', COUNT(*)::int FROM backorders_dataset
    UNION ALL SELECT 'products', COUNT(*)::int FROM products
    UNION ALL SELECT 'wholesale_accunts_dataset', COUNT(*)::int FROM wholesale_accunts_dataset
    UNION ALL SELECT 'hospital_units', COUNT(*)::int FROM hospital_units
    UNION ALL SELECT 'retailer_preorders', COUNT(*)::int FROM retailer_preorders
    UNION ALL SELECT 'workspace_documents', COUNT(*)::int FROM workspace_documents
    UNION ALL SELECT 'workspace_document_chunks', COUNT(*)::int FROM workspace_document_chunks;
  `);

  const velouraBackorders = await query(
    `SELECT * FROM backorders_dataset WHERE business_id = $1 ORDER BY backorder_id;`,
    [WS_VELOURA]
  );
  const velouraProducts = await query(
    `SELECT id, name, stock FROM products WHERE business_id = $1 ORDER BY name;`,
    [WS_VELOURA]
  );
  const ordersRows = await query(
    `SELECT "Order_ID", "Dispatch_Status", "Batch_Code", "SLA_Voucher_Issued", "Refund_Status"
     FROM orders WHERE business_id = $1 ORDER BY "Order_ID";`,
    [WS_ORDER_MGMT]
  );
  const whRows = await query(
    `SELECT "Batch_Record_ID", "Available_Units", "QC_Status"
     FROM warehouse_inventory_batches WHERE business_id = $1 ORDER BY "Batch_Record_ID";`,
    [WS_ORDER_MGMT]
  );

  return {
    tableCounts: tableCounts.rows,
    velouraBackorders: velouraBackorders.rows,
    velouraProducts: velouraProducts.rows,
    ordersRows: ordersRows.rows,
    whRows: whRows.rows,
  };
}

async function restoreBaseline(snapshot, workflowIds = [], sessionIds = []) {
  // Restore Veloura backorders_dataset to exact baseline
  const baselineBoIds = new Set(snapshot.velouraBackorders.map((r) => r.backorder_id));
  const curBo = await query(
    `SELECT backorder_id FROM backorders_dataset WHERE business_id = $1;`,
    [WS_VELOURA]
  );
  for (const row of curBo.rows) {
    if (!baselineBoIds.has(row.backorder_id)) {
      await query(
        `DELETE FROM backorders_dataset WHERE business_id = $1 AND backorder_id = $2;`,
        [WS_VELOURA, row.backorder_id]
      );
    }
  }
  for (const row of snapshot.velouraBackorders) {
    await query(
      `UPDATE backorders_dataset
       SET quantity_allocated = $3, fulfillment_status = $4
       WHERE business_id = $1 AND backorder_id = $2;`,
      [WS_VELOURA, row.backorder_id, row.quantity_allocated, row.fulfillment_status]
    );
  }
  for (const row of snapshot.velouraProducts) {
    await query(
      `UPDATE products SET stock = $3 WHERE business_id = $1 AND id = $2;`,
      [WS_VELOURA, row.id, row.stock]
    );
  }

  // Restore Customer Order Management orders & warehouse_inventory_batches to exact baseline
  const baselineOrdIds = new Set(snapshot.ordersRows.map((r) => r.Order_ID));
  const curOrd = await query(
    `SELECT "Order_ID" FROM orders WHERE business_id = $1;`,
    [WS_ORDER_MGMT]
  );
  for (const row of curOrd.rows) {
    if (!baselineOrdIds.has(row.Order_ID)) {
      await query(
        `DELETE FROM orders WHERE business_id = $1 AND "Order_ID" = $2;`,
        [WS_ORDER_MGMT, row.Order_ID]
      );
    }
  }
  for (const row of snapshot.ordersRows) {
    await query(
      `UPDATE orders
       SET "Dispatch_Status" = $3, "Batch_Code" = $4, "SLA_Voucher_Issued" = $5, "Refund_Status" = $6
       WHERE business_id = $1 AND "Order_ID" = $2;`,
      [
        WS_ORDER_MGMT,
        row.Order_ID,
        row.Dispatch_Status,
        row.Batch_Code,
        row.SLA_Voucher_Issued,
        row.Refund_Status,
      ]
    );
  }
  for (const row of snapshot.whRows) {
    await query(
      `UPDATE warehouse_inventory_batches
       SET "Available_Units" = $3, "QC_Status" = $4
       WHERE business_id = $1 AND "Batch_Record_ID" = $2;`,
      [WS_ORDER_MGMT, row.Batch_Record_ID, row.Available_Units, row.QC_Status]
    );
  }

  // Clean synthetic workflows and session turn memory rows
  for (const wfId of workflowIds) {
    if (wfId) {
      await query(`DELETE FROM socratic_workflows WHERE workflow_id = $1;`, [wfId]).catch(() => {});
    }
  }
  for (const { wsId, sessId } of sessionIds) {
    await clearSessionMemory(wsId, sessId).catch(() => {});
  }
}

async function runEval1TokenBudgetAndCacheOrder() {
  const opsTokens = estimateTokens(OPS_ANALYST_SYSTEM_PROMPT);
  const custTokens = estimateTokens(CUSTOMER_CARE_SYSTEM_PROMPT);
  assert.ok(opsTokens <= 400, `OPS_ANALYST_SYSTEM_PROMPT exceeded 400 tokens (${opsTokens})`);
  assert.ok(custTokens <= 400, `CUSTOMER_CARE_SYSTEM_PROMPT exceeded 400 tokens (${custTokens})`);

  const bloatedChunks = Array.from({ length: 8 }, (_, idx) => ({
    chunk_id: `chunk-${idx + 1}`,
    filename: `Policy_${idx + 1}.pdf`,
    locator: `Page 1, Chunk ${idx + 1}`,
    doc_type: 'policy',
    raw_text: `Rank ${idx + 1} policy clause ` + 'X'.repeat(1600),
  }));
  const memoryTurns = Array.from({ length: 5 }, (_, idx) => ({
    turn_number: idx + 1,
    user_intent_summary: `Turn ${idx + 1} summary ` + 'M'.repeat(120),
    action_taken: `READ_OP_${idx + 1}`,
    touched_tables: ['orders_table'],
    touched_row_keys: [`ROW-${idx + 1}`],
    outcome_summary: `Outcome ${idx + 1} ` + 'O'.repeat(180),
  }));
  const sqlObservations = [
    {
      step: 1,
      rows: Array.from({ length: 35 }, (_, idx) => ({
        order_id: `ORD-${100 + idx}`,
        customer_email: `buyer${idx}@example.com`,
        quantity_requested: idx + 5,
        status: 'Pending',
        description: 'Long prose narrative ' + 'D'.repeat(550),
        notes: 'Extra note ' + 'N'.repeat(450),
      })),
    },
  ];

  const promptObj = buildCacheOrderedPrompt({
    entity: 'user',
    toolDefinitions: getToolDefinitionsForEntity('user'),
    tables: [
      {
        tableName: 'orders_table',
        columns: { order_id: { exactName: 'order_id', type: 'string', modifiable: false } },
      },
    ],
    memoryTurns,
    rrfChunks: bloatedChunks,
    sqlObservations,
    userPrompt: 'Check reserve limit on pending items and draft buyer status updates.',
  });

  // Verify Cache-Ordering BEFORE budgeting
  const blockIds = promptObj.blocks.map((b) => b.id);
  assert.deepEqual(blockIds, [
    'system_prompt',
    'tool_definitions',
    'table_metadata',
    'turn_memory',
    'rrf_chunks',
    'sql_rows',
    'user_prompt',
  ]);
  const rrfBlockBefore = promptObj.blocks.find((b) => b.id === 'rrf_chunks');
  assert.equal(rrfBlockBefore.items[0].chunk_id, 'chunk-8', 'Lowest-ranked RRF chunk must sit first');
  assert.equal(rrfBlockBefore.items[7].chunk_id, 'chunk-1', 'Top-ranked RRF chunk must sit last near user query');

  const rawStaticPlusDynamicTokens =
    estimateTokens(promptObj.renderStaticPrefix()) +
    estimateTokens(promptObj.renderDynamicSuffix());
  assert.ok(
    rawStaticPlusDynamicTokens > 7000,
    `Expected raw bloated test payload > 7000 tokens, got ${rawStaticPlusDynamicTokens}`
  );

  const budgeted = enforceTokenBudget(promptObj.blocks, 4500);
  assert.ok(budgeted.estimatedTokens <= 4500, `Budget exceeded: ${budgeted.estimatedTokens}`);
  assert.equal(budgeted.trimmed, true);

  // Verify protected static blocks + user prompt untouched
  assert.equal(
    budgeted.blocks.find((b) => b.id === 'system_prompt').renderedText,
    OPS_ANALYST_SYSTEM_PROMPT
  );
  assert.ok(
    budgeted.blocks.find((b) => b.id === 'table_metadata').renderedText.includes('orders_table')
  );
  assert.ok(
    budgeted.blocks
      .find((b) => b.id === 'user_prompt')
      .renderedText.includes('Check reserve limit on pending items')
  );
  // Top 2 chunks kept (chunk-2, chunk-1)
  const keptChunkIds = budgeted.blocks
    .find((b) => b.id === 'rrf_chunks')
    .items.map((c) => c.chunk_id);
  assert.ok(keptChunkIds.length >= 2, 'Must keep at least top 2 RRF chunks');
  assert.ok(keptChunkIds.includes('chunk-1'), 'Top #1 RRF chunk must survive trimming');
  assert.ok(
    budgeted.blocks.find((b) => b.id === 'turn_memory').items.length >= 1,
    'Must keep at least latest memory turn'
  );

  return {
    passed: true,
    ops_system_tokens: opsTokens,
    cust_system_tokens: custTokens,
    raw_tokens: rawStaticPlusDynamicTokens,
    budgeted_tokens: budgeted.estimatedTokens,
    trim_log: budgeted.trimLog,
  };
}

async function runEval2ZodSelfRepair() {
  const capturedCalls = [];
  const providerFn = async ({ systemPrompt, userPrompt, isRepair }) => {
    capturedCalls.push({ systemPrompt, userPrompt, isRepair });
    if (capturedCalls.length === 1) {
      return '```json\n{"thought": "checking rows", "action": "bogus_action"}\n```';
    }
    return JSON.stringify({
      thought: 'Fixed schema output with valid final answer',
      action: 'final_answer',
      final_payload: {
        answer: 'Verified against active policy.',
        citations: [],
      },
    });
  };

  const { data, meta } = await invokeStructuredLLM({
    systemPrompt: OPS_ANALYST_SYSTEM_PROMPT,
    userPrompt: 'Check policy compliance.',
    zodSchema: ReActStepSchema,
    modelTier: 'fast',
    providerFn,
  });

  assert.equal(capturedCalls.length, 2, 'Expected exact 1 repair attempt after invalid schema');
  assert.equal(capturedCalls[1].isRepair, true);
  assert.ok(
    capturedCalls[1].userPrompt.includes('MALFORMED_OUTPUT:') &&
      capturedCalls[1].userPrompt.includes('VALIDATION_ISSUES:'),
    'Repair prompt must include ONLY malformed output and Zod issues'
  );
  assert.ok(
    !capturedCalls[1].userPrompt.includes('Check policy compliance.'),
    'Repair prompt should NOT resend full unrelated prompt'
  );
  assert.equal(data.action, 'final_answer');
  assert.equal(meta.repaired, true);
  assert.equal(meta.attempts, 2);

  return {
    passed: true,
    attempts: meta.attempts,
    repaired: meta.repaired,
  };
}

async function runEval3VagueIntentAcrossWorkspaces(trackedSessions) {
  const scenarios = [
    {
      workspaceId: WS_VELOURA,
      workspaceName: 'E-commerce clothing',
      prompt: 'are we short on anything for our open stuff?',
    },
    {
      workspaceId: WS_WHOLESALE,
      workspaceName: 'E-commerce Wholesale',
      prompt: 'who is late on paying us and should they get cut off?',
    },
    {
      workspaceId: WS_MEDICAL,
      workspaceName: 'Medical Staff & Deseases',
      prompt: 'can we take all the incoming emergency cases right now without hurting our clean bed floor?',
    },
    {
      workspaceId: WS_RBS,
      workspaceName: 'Raised By Society',
      prompt: 'do any waiting stockists want more beanies than we can safely ship?',
    },
  ];

  const details = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const sc = scenarios[i];
    const sessId = `eval3-vague-${i + 1}-${Date.now()}`;
    trackedSessions.push({ wsId: sc.workspaceId, sessId });

    const res = await executeWorkspaceOperation({
      businessId: sc.workspaceId,
      prompt: sc.prompt,
      sessionId: sessId,
    });

    assert.equal(
      res.status,
      'CONVERSATIONAL',
      `[${sc.workspaceName}] Expected read-only CONVERSATIONAL status, got ${res.status}`
    );
    assert.equal(res.intent, 'cross_source_read');
    assert.ok(res.answer && res.answer.length > 20, `[${sc.workspaceName}] Empty answer`);
    assert.ok(res.react_telemetry, `[${sc.workspaceName}] Missing react_telemetry`);
    assert.ok(
      Array.isArray(res.react_telemetry.expanded_queries) &&
        res.react_telemetry.expanded_queries.length >= 1 &&
        res.react_telemetry.expanded_queries.length <= 3,
      `[${sc.workspaceName}] Missing valid expanded_queries`
    );
    assert.ok(
      res.react_telemetry.steps_taken <= 3,
      `[${sc.workspaceName}] Exceeded 3 ReAct steps: ${res.react_telemetry.steps_taken}`
    );
    for (const tok of res.react_telemetry.estimated_input_tokens_per_call || []) {
      assert.ok(
        tok <= 4500,
        `[${sc.workspaceName}] Input token budget exceeded: ${tok}`
      );
    }

    // Verify all returned citations genuinely exist in PostgreSQL chunks or rows
    const activeChunks = (
      await query(
        `SELECT chunk_id, filename, page_number, locator, raw_text, is_active
         FROM workspace_document_chunks
         WHERE workspace_id = $1 AND is_active = true;`,
        [sc.workspaceId]
      )
    ).rows;
    const observedRowsForVerify = [
      ...(res.highlighted_rows || []).map((h) => ({
        table_name: h.table_name,
        row_identifier: h.row_identifier,
      })),
      ...(res.rows || []).map((r) => ({ row: r })),
    ];
    const verifiedAgainstDb = verifyCitations(
      res.citations,
      activeChunks,
      observedRowsForVerify
    );
    assert.ok(
      res.citations.length >= 1,
      `[${sc.workspaceName}] Expected at least 1 verified citation`
    );
    assert.equal(
      verifiedAgainstDb.length,
      res.citations.length,
      `[${sc.workspaceName}] Detected unverified citations`
    );

    details.push({
      workspace: sc.workspaceName,
      prompt: sc.prompt,
      expanded_queries: res.react_telemetry.expanded_queries,
      steps_taken: res.react_telemetry.steps_taken,
      avg_input_tokens: res.react_telemetry.avg_estimated_input_tokens,
      duration_ms: res.react_telemetry.duration_ms,
      citations_count: res.citations.length,
      citations_verified_pct: 100,
    });
  }

  return {
    passed: true,
    avg_steps: avg(details.map((d) => d.steps_taken)),
    avg_latency_ms: avg(details.map((d) => d.duration_ms)),
    avg_input_tokens: avg(details.map((d) => d.avg_input_tokens)),
    citations_accuracy_pct: 100,
    details,
  };
}

async function runEval4CustomerPersonaIsolation(trackedSessions) {
  const workspace = await findBusinessOrThrow(WS_ORDER_MGMT);
  const custRes = await query(
    `SELECT "Order_ID", "Customer_Name", "Customer_Email"
     FROM orders WHERE business_id = $1 LIMIT 1;`,
    [WS_ORDER_MGMT]
  );
  const cust = custRes.rows[0];
  const staffRes = await query(
    `SELECT DISTINCT "Hub_Lead_Email" FROM warehouse_inventory_batches WHERE business_id = $1;`,
    [WS_ORDER_MGMT]
  );
  const internalStaffEmails = staffRes.rows
    .map((r) => String(r.Hub_Lead_Email || '').trim().toLowerCase())
    .filter(Boolean);

  const sessId = `eval4-customer-${Date.now()}`;
  trackedSessions.push({ wsId: WS_ORDER_MGMT, sessId });

  const startedAt = Date.now();
  const reply = await generateWorkspaceCustomerReply({
    workspace,
    customerMessage:
      'If my item arrives defective, can I get a mobile money refund, and what is the current status of my order?',
    customerContext: {
      customer_name: cust.Customer_Name,
      customer_email: cust.Customer_Email,
      reference_id: cust.Order_ID,
    },
    conversationHistory: [],
    sessionId: sessId,
  });

  const textLower = String(reply.suggestion || '').toLowerCase();
  assert.ok(reply.suggestion && reply.suggestion.length > 25, 'Customer reply is empty');

  const forbiddenInternalStrings = [
    'warehouse_inventory_batches',
    'backorders_dataset',
    'wholesale_accunts_dataset',
    'workspace_table_metadata',
    'workspace_document_chunks',
    'hub_lead_email',
    'sla_voucher_issued',
    'dispatch_status',
    ...internalStaffEmails,
  ];
  for (const forbidden of forbiddenInternalStrings) {
    assert.ok(
      !textLower.includes(forbidden),
      `Customer reply leaked internal identifier or staff email: "${forbidden}"`
    );
  }

  const tel = reply.reactTelemetry || {};
  assert.ok((tel.steps_taken || 1) <= 3, `Customer ReAct exceeded 3 steps: ${tel.steps_taken}`);

  return {
    passed: true,
    steps_taken: tel.steps_taken || 1,
    avg_input_tokens: tel.avg_estimated_input_tokens || 0,
    duration_ms: Date.now() - startedAt,
    citations_count: (reply.citations || []).length,
    leaks_detected: 0,
  };
}

async function runEval5EndToEndAndOrderMgmtGuards(trackedWorkflows, trackedSessions) {
  // --- PART A: 3-Turn Veloura Regression ---
  const velouraSess = `eval5-veloura-${Date.now()}`;
  trackedSessions.push({ wsId: WS_VELOURA, sessId: velouraSess });
  const stepCounts = [];
  const tokenAvgs = [];
  const latencies = [];

  // Turn 1: Manifest Sync into backorders_dataset
  const t1Start = Date.now();
  const t1Preview = await executeWorkspaceOperation({
    businessId: WS_VELOURA,
    prompt: 'Add all 4 new backorders from Order_Manifest.pdf into the current table backorders_dataset.',
    entity: 'backorders_dataset',
    sessionId: velouraSess,
  });
  assert.equal(t1Preview.status, 'PREVIEW_READY', `Veloura Turn 1 expected PREVIEW_READY, got ${t1Preview.status}`);
  trackedWorkflows.push(t1Preview.workflow_id);
  const t1Confirm = await confirmWorkspaceOperation({
    workflowId: t1Preview.workflow_id,
    businessId: WS_VELOURA,
    confirm: true,
    allowPartialNullable: true,
    dryRun: true,
    sessionId: velouraSess,
  });
  assert.equal(t1Confirm.status, 'EXECUTED');
  assert.equal(t1Confirm.created_rows_count, 4, `Expected 4 created rows in Turn 1, got ${t1Confirm.created_rows_count}`);
  latencies.push(Date.now() - t1Start);

  // Turn 2: Cross-check the 4 newly added backorders against catalog stock + Company_Policy buffer
  const t2Res = await executeWorkspaceOperation({
    businessId: WS_VELOURA,
    prompt: 'Cross-check those 4 new backorders from Turn 1 against our products stock and Company_Policy.pdf mandatory safety buffer. Which ones do not have enough safe stock?',
    sessionId: velouraSess,
  });
  assert.equal(t2Res.status, 'CONVERSATIONAL');
  assert.equal(t2Res.intent, 'cross_source_read');
  assert.ok(t2Res.react_telemetry.steps_taken <= 3, `Veloura Turn 2 steps=${t2Res.react_telemetry.steps_taken}`);
  stepCounts.push(t2Res.react_telemetry.steps_taken);
  tokenAvgs.push(t2Res.react_telemetry.avg_estimated_input_tokens);
  latencies.push(t2Res.react_telemetry.duration_ms);

  // Turn 3: Allocate eligible orders from stock under mandatory buffer, update both tables, draft all 4 customer emails
  const t3Res = await executeWorkspaceOperation({
    businessId: WS_VELOURA,
    prompt: 'Now fulfill only the backorders among those 4 that satisfy the Company_Policy.pdf mandatory safety stock buffer, deduct the allocated units from products stock, update both backorders_dataset and products, and draft individualized emails to all 4 customers informing each buyer whether they are fulfilled or remain backordered.',
    sessionId: velouraSess,
  });
  assert.ok(
    ['PREVIEW_READY', 'CLARIFICATION_REQUIRED'].includes(t3Res.status),
    `Veloura Turn 3 expected PREVIEW_READY or CLARIFICATION_REQUIRED, got ${t3Res.status}`
  );
  trackedWorkflows.push(t3Res.workflow_id);
  stepCounts.push(t3Res.react_telemetry?.steps_taken || 1);
  if (t3Res.react_telemetry?.avg_estimated_input_tokens) {
    tokenAvgs.push(t3Res.react_telemetry.avg_estimated_input_tokens);
  }
  latencies.push(t3Res.react_telemetry?.duration_ms || 0);

  let finalVelouraPreview = t3Res;
  if (t3Res.status === 'CLARIFICATION_REQUIRED') {
    const q = t3Res.socratic_questions?.[0];
    const opt = q?.options?.[0];
    assert.ok(opt, 'Missing Socratic option on Turn 3 pause');
    finalVelouraPreview = await resolveSocraticWorkflow({
      workflowId: t3Res.workflow_id,
      selectedOptions: opt.option_id,
      businessId: WS_VELOURA,
    });
    assert.equal(finalVelouraPreview.status, 'PREVIEW_READY');
  }

  // Verify mutations span both backorders_dataset and products, and zero products.stock drops below buffer (5)
  const mutatedTables = new Set(
    (finalVelouraPreview.mutations_preview || []).map((m) => String(m.table_name || '').toLowerCase())
  );
  assert.ok(
    mutatedTables.has('backorders_dataset') && mutatedTables.has('products'),
    `Expected Turn 3 to mutate both backorders_dataset and products, got ${[...mutatedTables].join(', ')}`
  );
  for (const mut of finalVelouraPreview.mutations_preview || []) {
    if (String(mut.table_name || '').toLowerCase() === 'products' && mut.after?.stock !== undefined) {
      const afterStock = Number(mut.after.stock);
      if (Number.isFinite(afterStock)) {
        assert.ok(
          afterStock >= 5,
          `Veloura safety buffer violated on ${mut.row_identifier}: after stock = ${afterStock} (< 5)`
        );
      }
    }
  }
  assert.equal(
    (finalVelouraPreview.emails_preview || []).length,
    4,
    `Expected all 4/4 individualized customer email drafts, got ${(finalVelouraPreview.emails_preview || []).length}`
  );

  // Confirm HITL Stage 2 dryRun before DB cleanup
  const t3Confirm = await confirmWorkspaceOperation({
    workflowId: finalVelouraPreview.workflow_id,
    businessId: WS_VELOURA,
    confirm: true,
    dryRun: true,
    sessionId: velouraSess,
  });
  assert.equal(t3Confirm.status, 'EXECUTED');
  assert.equal(t3Confirm.dispatched_emails_count, 4);

  // --- PART B: Customer Order Management Reserve-Buffer + Audience Guard ---
  const omSess = `eval5-ordermgmt-${Date.now()}`;
  trackedSessions.push({ wsId: WS_ORDER_MGMT, sessId: omSess });

  // Turn 1: Add the 4 rush orders from Rush_Order_Dispatch_Manifest.pdf
  const omT1 = await executeWorkspaceOperation({
    businessId: WS_ORDER_MGMT,
    prompt: 'Add the 4 rush orders from Rush_Order_Dispatch_Manifest.pdf into the current table orders.',
    entity: 'orders',
    sessionId: omSess,
  });
  assert.equal(omT1.status, 'PREVIEW_READY', `Order Mgmt Turn 1 expected PREVIEW_READY, got ${omT1.status}`);
  trackedWorkflows.push(omT1.workflow_id);
  const omT1Confirm = await confirmWorkspaceOperation({
    workflowId: omT1.workflow_id,
    businessId: WS_ORDER_MGMT,
    confirm: true,
    allowPartialNullable: true,
    dryRun: true,
    sessionId: omSess,
  });
  assert.equal(omT1Confirm.created_rows_count, 4);

  // Check lead emails from warehouse_inventory_batches
  const whLeadRows = await query(
    `SELECT DISTINCT "Hub_Lead_Email" FROM warehouse_inventory_batches WHERE business_id = $1;`,
    [WS_ORDER_MGMT]
  );
  const hubLeadEmails = new Set(
    whLeadRows.rows.map((r) => String(r.Hub_Lead_Email || '').trim().toLowerCase()).filter(Boolean)
  );

  // Turn 2/Op: Enforce 10-unit hub reserve buffer limit and notify affected customers ONLY
  const omOp = await executeWorkspaceOperation({
    businessId: WS_ORDER_MGMT,
    prompt: 'Check the 4 new rush orders from Turn 1 against warehouse_inventory_batches respecting the mandatory hub reserve buffer limit in Hub_Reserve_Allocation_Policy.pdf. Allocate only orders whose batch keeps >= 10 units remaining, update orders and warehouse_inventory_batches, and email every customer their status.',
    sessionId: omSess,
  });
  assert.ok(
    ['PREVIEW_READY', 'CLARIFICATION_REQUIRED'].includes(omOp.status),
    `Order Mgmt reserve op expected PREVIEW_READY or CLARIFICATION_REQUIRED, got ${omOp.status}`
  );
  trackedWorkflows.push(omOp.workflow_id);
  if (omOp.react_telemetry?.steps_taken) stepCounts.push(omOp.react_telemetry.steps_taken);
  if (omOp.react_telemetry?.avg_estimated_input_tokens) {
    tokenAvgs.push(omOp.react_telemetry.avg_estimated_input_tokens);
  }
  if (omOp.react_telemetry?.duration_ms) latencies.push(omOp.react_telemetry.duration_ms);

  let finalOmPreview = omOp;
  if (omOp.status === 'CLARIFICATION_REQUIRED') {
    const q = omOp.socratic_questions?.[0];
    const opt = q?.options?.[0];
    finalOmPreview = await resolveSocraticWorkflow({
      workflowId: omOp.workflow_id,
      selectedOptions: opt.option_id,
      businessId: WS_ORDER_MGMT,
    });
  }

  for (const mut of finalOmPreview.mutations_preview || []) {
    if (String(mut.table_name).toLowerCase() === 'warehouse_inventory_batches') {
      const afterAvail = Number(mut.after?.Available_Units);
      if (Number.isFinite(afterAvail)) {
        assert.ok(
          afterAvail >= 10,
          `Hub reserve buffer violated on ${mut.row_identifier}: after Available_Units = ${afterAvail} (< 10)`
        );
      }
    }
  }
  const draftedRecipients = (finalOmPreview.emails_preview || []).map((e) =>
    String(e.recipient_email || '').trim().toLowerCase()
  );
  assert.ok(draftedRecipients.length >= 1, 'Expected customer email drafts in Order Mgmt flow');
  for (const email of draftedRecipients) {
    assert.ok(
      !hubLeadEmails.has(email),
      `Audience isolation failure: Hub_Lead_Email "${email}" leaked into customer emails`
    );
  }

  return {
    passed: true,
    veloura_3turn_passed: true,
    veloura_turn1_created: t1Confirm.created_rows_count,
    veloura_turn3_emails: finalVelouraPreview.emails_preview.length,
    order_mgmt_reserve_respected: true,
    order_mgmt_hub_lead_leaks: 0,
    avg_steps: avg(stepCounts),
    avg_latency_ms: avg(latencies),
    avg_input_tokens: avg(tokenAvgs),
  };
}

async function runEval6HitlAndBaselineCheck(baselineSnapshot, trackedWorkflows, trackedSessions) {
  const userToolNames = getToolDefinitionsForEntity('user').map((t) => t.name);
  const custToolNames = getToolDefinitionsForEntity('customer').map((t) => t.name);
  assert.ok(
    !userToolNames.some((n) => /execute_sql|commit|send_email/i.test(n)),
    'Tool registry must expose ZERO direct SQL write or SMTP dispatch tools'
  );
  assert.deepEqual(
    custToolNames,
    ['search_docs', 'query_tables_with_lookup'],
    'Customer mode must only expose read-only tools'
  );

  // Perform full restore and assert 100% baseline match
  await restoreBaseline(baselineSnapshot, trackedWorkflows, trackedSessions);
  const postSnapshot = await captureDbBaselineSnapshot();

  assert.deepEqual(
    postSnapshot.tableCounts,
    baselineSnapshot.tableCounts,
    'Post-cleanup table row counts differ from baseline'
  );
  assert.deepEqual(
    postSnapshot.velouraBackorders.map((r) => [r.backorder_id, r.quantity_allocated, r.fulfillment_status]),
    baselineSnapshot.velouraBackorders.map((r) => [r.backorder_id, r.quantity_allocated, r.fulfillment_status]),
    'Post-cleanup Veloura backorders differ from baseline'
  );
  assert.deepEqual(
    postSnapshot.velouraProducts.map((r) => [r.id, r.stock]),
    baselineSnapshot.velouraProducts.map((r) => [r.id, r.stock]),
    'Post-cleanup Veloura products stock differs from baseline'
  );
  assert.deepEqual(
    postSnapshot.ordersRows,
    baselineSnapshot.ordersRows,
    'Post-cleanup Customer Order Management orders differ from baseline'
  );
  assert.deepEqual(
    postSnapshot.whRows,
    baselineSnapshot.whRows,
    'Post-cleanup warehouse_inventory_batches differ from baseline'
  );

  return {
    passed: true,
    hitl_direct_write_tools: 0,
    baseline_restored_100pct: true,
    workspaces_checked: ALL_WORKSPACES.length,
  };
}

async function main() {
  process.env.SMTP_TEST_MODE = 'true';
  const baselineSnapshot = await captureDbBaselineSnapshot();
  const trackedWorkflows = [];
  const trackedSessions = [];

  try {
    const eval1 = await runEval1TokenBudgetAndCacheOrder();
    const eval2 = await runEval2ZodSelfRepair();
    const eval3 = await runEval3VagueIntentAcrossWorkspaces(trackedSessions);
    const eval4 = await runEval4CustomerPersonaIsolation(trackedSessions);
    const eval5 = await runEval5EndToEndAndOrderMgmtGuards(trackedWorkflows, trackedSessions);
    const eval6 = await runEval6HitlAndBaselineCheck(
      baselineSnapshot,
      trackedWorkflows,
      trackedSessions
    );

    const summary = {
      status: 'ALL_PHASE2_EVALS_PASSED',
      eval1_token_budget_cache_order: eval1,
      eval2_zod_self_repair: eval2,
      eval3_vague_intent_workspaces: eval3,
      eval4_customer_persona_isolation: eval4,
      eval5_e2e_veloura_and_order_mgmt: eval5,
      eval6_hitl_and_db_baseline: eval6,
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error('EVAL_STEP_ERROR:', err);
    throw err;
  } finally {
    await restoreBaseline(baselineSnapshot, trackedWorkflows, trackedSessions).catch((err) => {
      console.error('[CleanupError]', err);
    });
    const pool = typeof getPool === 'function' ? getPool() : null;
    if (pool && typeof pool.end === 'function') {
      await pool.end().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('PHASE2_EVAL_FAILED:', err);
  process.exit(1);
});
