require('dotenv').config();

const assert = require('node:assert/strict');
const { query, getPool } = require('../db');
const env = require('../src/config/env');
const {
  callOpenAICompatible,
  callGeminiFallback,
} = require('../src/services/llm/providerAdapters');
const {
  invokeLLM,
  getTierWaterfall,
  getGatewayHealthSnapshot,
  resetGatewayHealth,
  getRecentLLMDiagnostics,
  clearRecentLLMDiagnostics,
  setAdapterOverrides,
} = require('../src/services/llm/llmGatewayService');
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

const WS_VELOURA = '684a8863-5094-4c8b-9b15-c50c06335b7f';

function avg(nums = []) {
  if (!nums.length) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

async function captureVelouraSnapshot() {
  const tableCounts = await query(`
    SELECT 'orders' AS tbl, COUNT(*)::int AS cnt FROM orders
    UNION ALL SELECT 'warehouse_inventory_batches', COUNT(*)::int FROM warehouse_inventory_batches
    UNION ALL SELECT 'backorders_dataset', COUNT(*)::int FROM backorders_dataset
    UNION ALL SELECT 'products', COUNT(*)::int FROM products
    UNION ALL SELECT 'supplier_purchase_orders', COUNT(*)::int FROM supplier_purchase_orders
    UNION ALL SELECT 'workspace_documents', COUNT(*)::int FROM workspace_documents
    UNION ALL SELECT 'workspace_document_chunks', COUNT(*)::int FROM workspace_document_chunks;
  `);

  const backorders = await query(
    `SELECT backorder_id, quantity_allocated, fulfillment_status
     FROM backorders_dataset WHERE business_id = $1 ORDER BY backorder_id;`,
    [WS_VELOURA]
  );
  const products = await query(
    `SELECT id, name, stock
     FROM products WHERE business_id = $1 ORDER BY name;`,
    [WS_VELOURA]
  );
  return {
    tableCounts: tableCounts.rows,
    backorders: backorders.rows,
    products: products.rows,
  };
}

async function restoreVelouraSnapshot(snapshot, workflowIds = [], sessionIds = []) {
  if (!snapshot) return;
  const baselineBoIds = new Set(snapshot.backorders.map((r) => r.backorder_id));
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
  for (const row of snapshot.backorders) {
    await query(
      `UPDATE backorders_dataset
       SET quantity_allocated = $3, fulfillment_status = $4
       WHERE business_id = $1 AND backorder_id = $2;`,
      [WS_VELOURA, row.backorder_id, row.quantity_allocated, row.fulfillment_status]
    );
  }
  for (const row of snapshot.products) {
    await query(
      `UPDATE products SET stock = $3 WHERE business_id = $1 AND id = $2;`,
      [WS_VELOURA, row.id, row.stock]
    );
  }

  for (const wfId of workflowIds) {
    await query(`DELETE FROM workspace_operations_workflows WHERE id = $1;`, [wfId]).catch(() => {});
  }
  for (const s of sessionIds) {
    await clearSessionMemory(s.wsId, s.sessId).catch(() => {});
  }
}

/**
 * EVAL 1: Config Hydration & Runtime URL Interpolation
 */
async function runEval1ConfigHydration() {
  const interpolated = env.resolveCloudflareBaseUrl(
    'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/',
    'abc123'
  );
  assert.equal(
    interpolated,
    'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
    'Expected ${CLOUDFLARE_ACCOUNT_ID} placeholder to expand cleanly'
  );

  const fallbackConstructed = env.resolveCloudflareBaseUrl('', 'acct999');
  assert.equal(
    fallbackConstructed,
    'https://api.cloudflare.com/client/v4/accounts/acct999/ai/v1'
  );

  assert.ok(env.groqApiKey && env.groqApiKey.length > 10, 'Missing env.groqApiKey');
  assert.ok(env.cloudflareApiKey && env.cloudflareApiKey.length > 10, 'Missing env.cloudflareApiKey');
  assert.ok(env.geminiApiKey && env.geminiApiKey.length > 10, 'Missing env.geminiApiKey');
  assert.ok(env.groqBaseUrl && !env.groqBaseUrl.endsWith('/'), 'Invalid groqBaseUrl');
  assert.ok(
    env.cloudflareBaseUrl &&
      !env.cloudflareBaseUrl.includes('${') &&
      env.cloudflareBaseUrl.includes(env.cloudflareAccountId),
    'Invalid or unexpanded cloudflareBaseUrl'
  );

  const fastWaterfall = getTierWaterfall('fast');
  const reasoningWaterfall = getTierWaterfall('reasoning');
  assert.ok(fastWaterfall.length >= 3, `Expected >= 3 fast candidates, got ${fastWaterfall.length}`);
  assert.equal(fastWaterfall[0].provider, 'groq');
  assert.equal(fastWaterfall[1].provider, 'cloudflare');
  assert.equal(fastWaterfall[fastWaterfall.length - 1].provider, 'gemini');
  const fastKeys = fastWaterfall.map((c) => `${c.provider}:${c.model}`);
  assert.ok(fastKeys.includes(`groq:${env.groqReasoningBackupModel}`), 'fast tier missing groq backup overflow');
  assert.ok(fastKeys.includes(`cloudflare:${env.cloudflareReasoningModel}`), 'fast tier missing cloudflare reasoning overflow');
  assert.equal(
    reasoningWaterfall.length,
    4,
    `Expected 4 reasoning candidates, got ${reasoningWaterfall.length}`
  );
  assert.deepEqual(
    reasoningWaterfall.map((c) => c.provider),
    ['groq', 'groq', 'cloudflare', 'gemini']
  );

  return {
    passed: true,
    cloudflare_interpolation_ok: true,
    fast_waterfall_models: fastWaterfall.map((c) => `${c.provider}:${c.model}`),
    reasoning_waterfall_models: reasoningWaterfall.map((c) => `${c.provider}:${c.model}`),
  };
}

/**
 * EVAL 2: Live 6-Model Connectivity & Structured JSON Smoke Test
 */
async function runEval2Live6ModelConnectivity() {
  const probeTargets = [
    {
      tier: 'fast',
      provider: 'groq',
      model: env.groqFastModel,
      call: () =>
        callOpenAICompatible({
          provider: 'groq',
          baseUrl: env.groqBaseUrl,
          apiKey: env.groqApiKey,
          model: env.groqFastModel,
          systemPrompt: 'Return ONLY a compact JSON object.',
          userPrompt: 'Return JSON: {"ok": true, "provider": "groq", "sum": 7}',
          expectJson: true,
          maxTokens: 256,
          timeoutMs: 12000,
        }),
    },
    {
      tier: 'reasoning',
      provider: 'groq',
      model: env.groqReasoningModel,
      call: () =>
        callOpenAICompatible({
          provider: 'groq',
          baseUrl: env.groqBaseUrl,
          apiKey: env.groqApiKey,
          model: env.groqReasoningModel,
          systemPrompt: 'Return ONLY a compact JSON object.',
          userPrompt: 'Return JSON: {"ok": true, "provider": "groq", "sum": 7}',
          expectJson: true,
          maxTokens: 256,
          timeoutMs: 15000,
        }),
    },
    {
      tier: 'reasoning_backup',
      provider: 'groq',
      model: env.groqReasoningBackupModel,
      call: () =>
        callOpenAICompatible({
          provider: 'groq',
          baseUrl: env.groqBaseUrl,
          apiKey: env.groqApiKey,
          model: env.groqReasoningBackupModel,
          systemPrompt: 'Return ONLY a compact JSON object.',
          userPrompt: 'Return JSON: {"ok": true, "provider": "groq", "sum": 7}',
          expectJson: true,
          maxTokens: 256,
          timeoutMs: 15000,
        }),
    },
    {
      tier: 'fast',
      provider: 'cloudflare',
      model: env.cloudflareFastModel,
      call: () =>
        callOpenAICompatible({
          provider: 'cloudflare',
          baseUrl: env.cloudflareBaseUrl,
          apiKey: env.cloudflareApiKey,
          model: env.cloudflareFastModel,
          systemPrompt: 'Return ONLY a compact JSON object.',
          userPrompt: 'Return JSON: {"ok": true, "provider": "cloudflare", "sum": 7}',
          expectJson: true,
          maxTokens: 256,
          timeoutMs: 18000,
        }),
    },
    {
      tier: 'reasoning',
      provider: 'cloudflare',
      model: env.cloudflareReasoningModel,
      call: () =>
        callOpenAICompatible({
          provider: 'cloudflare',
          baseUrl: env.cloudflareBaseUrl,
          apiKey: env.cloudflareApiKey,
          model: env.cloudflareReasoningModel,
          systemPrompt: 'Return ONLY a compact JSON object.',
          userPrompt: 'Return JSON: {"ok": true, "provider": "cloudflare", "sum": 7}',
          expectJson: true,
          maxTokens: 256,
          timeoutMs: 20000,
        }),
    },
    {
      tier: 'tertiary',
      provider: 'gemini',
      model: env.geminiModel,
      call: () =>
        callGeminiFallback({
          model: env.geminiModel,
          apiKey: env.geminiApiKey,
          systemPrompt: 'Return ONLY a compact JSON object.',
          userPrompt: 'Return JSON: {"ok": true, "provider": "gemini", "sum": 7}',
          expectJson: true,
          maxTokens: 256,
          timeoutMs: 18000,
          thinkingBudget: 0,
        }),
    },
  ];

  const results = [];
  for (const target of probeTargets) {
    const startedAt = Date.now();
    try {
      const res = await target.call();
      const parsed = JSON.parse(res.text);
      const validJson = Boolean(parsed && parsed.ok === true && Number(parsed.sum) === 7);
      results.push({
        provider: target.provider,
        model: target.model,
        tier: target.tier,
        ok: true,
        httpStatus: 200,
        durationMs: Date.now() - startedAt,
        validJson,
        inputTokens: res.usage?.inputTokens || 0,
        outputTokens: res.usage?.outputTokens || 0,
        cachedTokens: res.usage?.cachedTokens || 0,
        error: null,
      });
    } catch (err) {
      results.push({
        provider: target.provider,
        model: target.model,
        tier: target.tier,
        ok: false,
        httpStatus: err?.upstreamStatus || err?.code || 'ERR',
        durationMs: Date.now() - startedAt,
        validJson: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        error: String(err?.message || 'Unknown error').slice(0, 180),
      });
    }
  }

  console.info('[Eval2 6-Model Connectivity Table]', JSON.stringify(results, null, 2));

  const okByProvider = {
    groq: results.some((r) => r.provider === 'groq' && r.ok && r.validJson),
    cloudflare: results.some((r) => r.provider === 'cloudflare' && r.ok && r.validJson),
    gemini: results.some((r) => r.provider === 'gemini' && r.ok),
  };
  assert.ok(okByProvider.groq, 'Expected at least 1 live Groq model to return valid JSON');
  assert.ok(okByProvider.cloudflare, 'Expected at least 1 live Cloudflare model to return valid JSON');
  if (!okByProvider.gemini) {
    console.warn('[Eval2 Warning] Tertiary Gemini probe failed (logged transparently in connectivity table).');
  }

  return {
    passed: true,
    ok_by_provider: okByProvider,
    connectivity_table: results,
  };
}

/**
 * EVAL 3: Deterministic Multi-Provider Failover Drills (Drills A-D)
 */
async function runEval3FailoverDrills() {
  try {
    // Drill A: Groq 429 -> Cloudflare + Cooldown Skip Verification
    resetGatewayHealth();
    const callCountsA = [];
    setAdapterOverrides({
      callOpenAICompatible: async ({ provider, model }) => {
        callCountsA.push(`${provider}:${model}`);
        if (provider === 'groq') {
          const err = new Error('Simulated Groq 429 rate limit');
          err.upstreamStatus = 429;
          err.retryAfterMs = 5000;
          err.code = 'RATE_LIMITED';
          throw err;
        }
        return {
          text: JSON.stringify({ drill: 'A', ok: true, provider }),
          provider,
          model,
          usage: { inputTokens: 120, outputTokens: 20, cachedTokens: 0 },
        };
      },
      callGeminiFallback: async ({ model }) => ({
        text: JSON.stringify({ drill: 'A', ok: true, provider: 'gemini' }),
        provider: 'gemini',
        model,
        usage: { inputTokens: 120, outputTokens: 20, cachedTokens: 0 },
      }),
    });

    const drillA1 = await invokeLLM({
      tier: 'fast',
      systemPrompt: 'Return JSON.',
      userPrompt: 'ping',
      expectJson: true,
      operationName: 'drill_a_first',
    });
    assert.equal(drillA1.provider, 'cloudflare');
    assert.equal(drillA1.fallbackUsed, true);
    const snapA = getGatewayHealthSnapshot();
    const groqFastKey = `groq:${env.groqFastModel}`;
    assert.equal(snapA[groqFastKey]?.available, false, 'Expected Groq fast model to enter cooldown');

    const callCountBeforeA2 = callCountsA.length;
    const drillA2 = await invokeLLM({
      tier: 'fast',
      systemPrompt: 'Return JSON.',
      userPrompt: 'ping 2',
      expectJson: true,
      operationName: 'drill_a_second',
    });
    assert.equal(drillA2.provider, 'cloudflare');
    const secondCallModels = callCountsA.slice(callCountBeforeA2);
    assert.deepEqual(
      secondCallModels,
      [`cloudflare:${env.cloudflareFastModel}`],
      'Expected cooled Groq model to be skipped on 2nd request'
    );

    // Drill B: Groq 429 + Cloudflare 503 -> Gemini
    resetGatewayHealth();
    setAdapterOverrides({
      callOpenAICompatible: async ({ provider }) => {
        const err = new Error(`Simulated ${provider} failure`);
        err.upstreamStatus = provider === 'groq' ? 429 : 503;
        err.code = provider === 'groq' ? 'RATE_LIMITED' : 'UPSTREAM_SERVER_ERROR';
        throw err;
      },
      callGeminiFallback: async ({ model }) => ({
        text: JSON.stringify({ drill: 'B', ok: true, provider: 'gemini' }),
        provider: 'gemini',
        model,
        usage: { inputTokens: 150, outputTokens: 25, cachedTokens: 0 },
      }),
    });
    const drillB = await invokeLLM({
      tier: 'fast',
      systemPrompt: 'Return JSON.',
      userPrompt: 'ping b',
      expectJson: true,
      operationName: 'drill_b',
    });
    assert.equal(drillB.provider, 'gemini');
    assert.equal(drillB.fallbackUsed, true);

    // Drill C: Reasoning Primary 500 -> Reasoning Backup -> Timeout -> Cloudflare Reasoning
    resetGatewayHealth();
    setAdapterOverrides({
      callOpenAICompatible: async ({ provider, model }) => {
        if (provider === 'groq' && model === env.groqReasoningModel) {
          const err = new Error('Simulated 500 primary');
          err.upstreamStatus = 500;
          err.code = 'UPSTREAM_SERVER_ERROR';
          throw err;
        }
        return {
          text: JSON.stringify({ drill: 'C1', ok: true, model }),
          provider,
          model,
          usage: { inputTokens: 200, outputTokens: 30, cachedTokens: 0 },
        };
      },
    });
    const drillC1 = await invokeLLM({
      tier: 'reasoning',
      systemPrompt: 'Return JSON.',
      userPrompt: 'ping c1',
      expectJson: true,
      operationName: 'drill_c1',
    });
    assert.equal(drillC1.provider, 'groq');
    assert.equal(drillC1.model, env.groqReasoningBackupModel);
    assert.equal(drillC1.fallbackUsed, true);

    resetGatewayHealth();
    setAdapterOverrides({
      callOpenAICompatible: async ({ provider, model }) => {
        if (provider === 'groq' && model === env.groqReasoningModel) {
          const err = new Error('Simulated 500 primary');
          err.upstreamStatus = 500;
          err.code = 'UPSTREAM_SERVER_ERROR';
          throw err;
        }
        if (provider === 'groq' && model === env.groqReasoningBackupModel) {
          const err = new Error('Simulated timeout on backup');
          err.code = 'LLM_TIMEOUT';
          throw err;
        }
        return {
          text: JSON.stringify({ drill: 'C2', ok: true, provider, model }),
          provider,
          model,
          usage: { inputTokens: 220, outputTokens: 35, cachedTokens: 0 },
        };
      },
    });
    const drillC2 = await invokeLLM({
      tier: 'reasoning',
      systemPrompt: 'Return JSON.',
      userPrompt: 'ping c2',
      expectJson: true,
      operationName: 'drill_c2',
    });
    assert.equal(drillC2.provider, 'cloudflare');
    assert.equal(drillC2.model, env.cloudflareReasoningModel);
    assert.equal(drillC2.fallbackUsed, true);

    // Drill D: All Providers Exhausted -> Clean AppError 503
    resetGatewayHealth();
    setAdapterOverrides({
      callOpenAICompatible: async () => {
        const err = new Error('Simulated outage');
        err.upstreamStatus = 503;
        throw err;
      },
      callGeminiFallback: async () => {
        const err = new Error('Simulated Gemini outage');
        err.upstreamStatus = 503;
        throw err;
      },
    });
    let drillDCaught = null;
    try {
      await invokeLLM({
        tier: 'fast',
        systemPrompt: 'Return JSON.',
        userPrompt: 'ping d',
        expectJson: true,
        operationName: 'drill_d',
      });
    } catch (err) {
      drillDCaught = err;
    }
    assert.ok(drillDCaught, 'Expected Drill D to throw');
    assert.equal(drillDCaught.statusCode, 503);
    assert.equal(drillDCaught.code, 'LLM_GATEWAY_EXHAUSTED');

    return {
      passed: true,
      drill_a: `groq:429 -> ${drillA1.provider}:${drillA1.model} (2nd call skipped Groq cleanly)`,
      drill_b: `groq:429 + cloudflare:503 -> ${drillB.provider}:${drillB.model}`,
      drill_c: `primary:500 -> ${drillC1.model}; backup:timeout -> ${drillC2.provider}:${drillC2.model}`,
      drill_d: `all_exhausted -> HTTP ${drillDCaught.statusCode} (${drillDCaught.code})`,
    };
  } finally {
    setAdapterOverrides(null);
    resetGatewayHealth();
  }
}

/**
 * EVAL 4: Live End-to-End 3-Turn Veloura Regression on Groq-First Gateway
 */
async function runEval4VelouraLiveE2E(baselineSnapshot, trackedWorkflows, trackedSessions) {
  resetGatewayHealth();
  clearRecentLLMDiagnostics();

  const velouraSess = `phase3-veloura-${Date.now()}`;
  trackedSessions.push({ wsId: WS_VELOURA, sessId: velouraSess });

  const latencies = [];
  const stepCounts = [];
  const tokenAvgs = [];

  // Turn 1: Sync 4 backorders from Order_Manifest.pdf
  const t1Start = Date.now();
  const t1Preview = await executeWorkspaceOperation({
    businessId: WS_VELOURA,
    prompt: 'Add all 4 new backorders from Order_Manifest.pdf into the current table backorders_dataset.',
    entity: 'backorders_dataset',
    sessionId: velouraSess,
  });
  assert.equal(t1Preview.status, 'PREVIEW_READY', `Turn 1 expected PREVIEW_READY, got ${t1Preview.status}`);
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

  // Turn 2: Cross-check those 4 new backorders against products stock & Company_Policy.pdf buffer
  const t2Start = Date.now();
  const t2Res = await executeWorkspaceOperation({
    businessId: WS_VELOURA,
    prompt: 'Cross-check those 4 new backorders from Turn 1 against our products stock and Company_Policy.pdf mandatory safety buffer. Which ones do not have enough safe stock?',
    sessionId: velouraSess,
  });
  assert.equal(t2Res.status, 'CONVERSATIONAL', `Turn 2 expected CONVERSATIONAL, got ${t2Res.status}`);
  stepCounts.push(t2Res.react_telemetry?.steps_taken || 1);
  if (t2Res.react_telemetry?.avg_estimated_input_tokens) {
    tokenAvgs.push(t2Res.react_telemetry.avg_estimated_input_tokens);
  }
  latencies.push(t2Res.react_telemetry?.duration_ms || (Date.now() - t2Start));

  // Turn 3: Fulfill eligible orders under mandatory safety stock buffer, update both tables, email all 4 customers
  const t3Start = Date.now();
  const t3Res = await executeWorkspaceOperation({
    businessId: WS_VELOURA,
    prompt: 'Now fulfill only the backorders among those 4 that satisfy the Company_Policy.pdf mandatory safety stock buffer, deduct the allocated units from products stock, update both backorders_dataset and products, and draft individualized emails to all 4 customers informing each buyer whether they are fulfilled or remain backordered.',
    sessionId: velouraSess,
  });
  assert.ok(
    ['PREVIEW_READY', 'CLARIFICATION_REQUIRED'].includes(t3Res.status),
    `Turn 3 expected PREVIEW_READY or CLARIFICATION_REQUIRED, got ${t3Res.status} | message=${String(t3Res.message || t3Res.answer || '').slice(0, 400)} | intent=${t3Res.intent} | keys=${Object.keys(t3Res || {}).join(',')}`
  );
  trackedWorkflows.push(t3Res.workflow_id);
  stepCounts.push(t3Res.react_telemetry?.steps_taken || 1);
  if (t3Res.react_telemetry?.avg_estimated_input_tokens) {
    tokenAvgs.push(t3Res.react_telemetry.avg_estimated_input_tokens);
  }
  latencies.push(t3Res.react_telemetry?.duration_ms || (Date.now() - t3Start));

  let finalPreview = t3Res;
  if (t3Res.status === 'CLARIFICATION_REQUIRED') {
    const q = t3Res.socratic_questions?.[0];
    const opt = q?.options?.[0];
    assert.ok(opt, 'Missing Socratic option on Turn 3 pause');
    finalPreview = await resolveSocraticWorkflow({
      workflowId: t3Res.workflow_id,
      selectedOptions: opt.option_id,
      businessId: WS_VELOURA,
    });
    assert.equal(finalPreview.status, 'PREVIEW_READY');
  }

  const mutatedTables = new Set(
    (finalPreview.mutations_preview || []).map((m) => String(m.table_name || '').toLowerCase())
  );
  assert.ok(
    mutatedTables.has('backorders_dataset') && mutatedTables.has('products'),
    `Expected Turn 3 to mutate both backorders_dataset and products, got ${[...mutatedTables].join(', ')}`
  );
  for (const mut of finalPreview.mutations_preview || []) {
    if (String(mut.table_name || '').toLowerCase() === 'products' && mut.after?.stock !== undefined) {
      const afterStock = Number(mut.after.stock);
      if (Number.isFinite(afterStock)) {
        assert.ok(afterStock >= 5, `Veloura safety buffer violated on ${mut.row_identifier}: stock=${afterStock}`);
      }
    }
  }
  assert.equal(
    (finalPreview.emails_preview || []).length,
    4,
    `Expected 4/4 email drafts, got ${(finalPreview.emails_preview || []).length}`
  );

  const t3Confirm = await confirmWorkspaceOperation({
    workflowId: finalPreview.workflow_id,
    businessId: WS_VELOURA,
    confirm: true,
    dryRun: true,
    sessionId: velouraSess,
  });
  assert.equal(t3Confirm.status, 'EXECUTED');
  assert.equal(t3Confirm.dispatched_emails_count, 4);

  const diagnosticsSnapshot = getRecentLLMDiagnostics(50).filter((d) => d.status === 'ok');
  const providersUsed = Array.from(new Set(diagnosticsSnapshot.map((d) => `${d.provider}:${d.model}`)));

  await restoreVelouraSnapshot(baselineSnapshot, trackedWorkflows, trackedSessions);

  return {
    passed: true,
    turn1_created_rows: t1Confirm.created_rows_count,
    turn2_status: t2Res.status,
    turn3_emails_drafted: t3Confirm.dispatched_emails_count,
    avg_steps: avg(stepCounts),
    avg_latency_ms: avg(latencies),
    turn_latencies_ms: latencies,
    avg_input_tokens: avg(tokenAvgs),
    providers_used: providersUsed,
  };
}

/**
 * EVAL 5: Live Customer Entity (entity: "customer") Grounded Reply Test
 */
async function runEval5CustomerEntity(trackedSessions) {
  const workspace = await findBusinessOrThrow(WS_VELOURA);
  const sampleBo = await query(
    `SELECT backorder_id, customer_name, customer_email, item_name
     FROM backorders_dataset WHERE business_id = $1 LIMIT 1;`,
    [WS_VELOURA]
  );
  const cust = sampleBo.rows[0];
  const poEmailsRes = await query(
    `SELECT DISTINCT supplier_email FROM supplier_purchase_orders WHERE business_id = $1;`,
    [WS_VELOURA]
  );
  const internalSupplierEmails = poEmailsRes.rows
    .map((r) => String(r.supplier_email || '').trim().toLowerCase())
    .filter(Boolean);

  const sessId = `phase3-customer-${Date.now()}`;
  trackedSessions.push({ wsId: WS_VELOURA, sessId });

  const startedAt = Date.now();
  const reply = await generateWorkspaceCustomerReply({
    workspace,
    customerMessage:
      'What is your restocking and safety stock policy on backordered items, and what is the current status of my backorder?',
    customerContext: {
      customer_name: cust.customer_name,
      customer_email: cust.customer_email,
      reference_id: cust.backorder_id,
    },
    conversationHistory: [],
    sessionId: sessId,
  });

  const suggestion = String(reply?.suggestion || '').trim();
  assert.ok(suggestion.length > 25, 'Expected non-empty grounded customer reply');

  const lower = suggestion.toLowerCase();
  for (const internal of [
    'supplier_purchase_orders',
    'workspace_table_metadata',
    'workspace_document_chunks',
    ...internalSupplierEmails,
  ]) {
    assert.ok(!lower.includes(internal), `Customer reply leaked internal identifier "${internal}"`);
  }

  return {
    passed: true,
    duration_ms: Date.now() - startedAt,
    steps_taken: reply?.reactTelemetry?.steps_taken || 1,
    citations_count: (reply?.citations || []).length,
    leaks_detected: 0,
  };
}

/**
 * EVAL 6: Diagnostics & Token Budget Audit + DB Baseline Verification
 */
async function runEval6DiagnosticsAndBaselineAudit(baselineSnapshot, trackedWorkflows, trackedSessions) {
  const diagnostics = getRecentLLMDiagnostics(50);
  const okEntries = diagnostics.filter((d) => d.status === 'ok');
  assert.ok(okEntries.length >= 3, `Expected >= 3 gateway diagnostic calls, got ${okEntries.length}`);

  const totalInput = okEntries.reduce((acc, d) => acc + (d.inputTokens || 0), 0);
  const totalCached = okEntries.reduce((acc, d) => acc + (d.cachedTokens || 0), 0);
  const avgInputTokens = avg(okEntries.map((d) => d.inputTokens || 0));
  const avgDurationMs = avg(okEntries.map((d) => d.durationMs || 0));
  const maxObservedInput = Math.max(...okEntries.map((d) => d.inputTokens || 0));

  for (const entry of okEntries) {
    assert.ok(entry.provider && entry.model, 'Diagnostic entry missing provider/model');
    assert.ok(
      entry.inputTokens <= 5500,
      `Gateway input tokens exceeded budget ceiling: ${entry.inputTokens} on ${entry.operationName}`
    );
  }

  // Final DB baseline check
  await restoreVelouraSnapshot(baselineSnapshot, trackedWorkflows, trackedSessions);
  const postSnapshot = await captureVelouraSnapshot();
  assert.deepEqual(postSnapshot.tableCounts, baselineSnapshot.tableCounts, 'Post-eval table counts differ from baseline');
  assert.deepEqual(postSnapshot.backorders, baselineSnapshot.backorders, 'Post-eval Veloura backorders differ from baseline');
  assert.deepEqual(postSnapshot.products, baselineSnapshot.products, 'Post-eval Veloura products differ from baseline');

  return {
    passed: true,
    recorded_ok_calls: okEntries.length,
    avg_input_tokens: avgInputTokens,
    max_input_tokens: maxObservedInput,
    total_cached_tokens: totalCached,
    cache_hit_ratio_pct:
      totalInput > 0 ? Math.round((totalCached / totalInput) * 10000) / 100 : 0,
    avg_llm_call_ms: avgDurationMs,
    providers_summary: Array.from(new Set(okEntries.map((d) => `${d.provider}:${d.model}`))),
    baseline_restored_100pct: true,
  };
}

async function main() {
  process.env.SMTP_TEST_MODE = 'true';
  const baselineSnapshot = await captureVelouraSnapshot();
  const trackedWorkflows = [];
  const trackedSessions = [];

  try {
    const eval1 = await runEval1ConfigHydration();
    const eval2 = await runEval2Live6ModelConnectivity();
    const eval3 = await runEval3FailoverDrills();
    const eval4 = await runEval4VelouraLiveE2E(baselineSnapshot, trackedWorkflows, trackedSessions);
    const eval5 = await runEval5CustomerEntity(trackedSessions);
    const eval6 = await runEval6DiagnosticsAndBaselineAudit(
      baselineSnapshot,
      trackedWorkflows,
      trackedSessions
    );

    console.log(
      JSON.stringify(
        {
          status: 'ALL_PHASE3_EVALS_PASSED',
          eval1_config_hydration: eval1,
          eval2_live_6_model_connectivity: eval2,
          eval3_failover_drills: eval3,
          eval4_veloura_e2e_groq_first: eval4,
          eval5_customer_entity_grounded: eval5,
          eval6_diagnostics_and_baseline: eval6,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error('PHASE3_EVAL_ERROR:', err);
    throw err;
  } finally {
    setAdapterOverrides(null);
    resetGatewayHealth();
    await restoreVelouraSnapshot(baselineSnapshot, trackedWorkflows, trackedSessions).catch((e) => {
      console.error('[CleanupError]', e);
    });
    const pool = typeof getPool === 'function' ? getPool() : null;
    if (pool && typeof pool.end === 'function') {
      await pool.end().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('PHASE3_EVAL_FAILED:', err);
  process.exit(1);
});
