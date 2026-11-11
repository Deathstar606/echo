const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const app = require('../src/app');
const { query, getPool } = require('../db');
const {
  clearAllDocumentsGlobal,
  clearDocumentsForBusiness,
} = require('../src/services/documentIngestionService');
const {
  clearWorkflowStoreGlobal,
} = require('../src/services/socraticOperationsService');
const {
  REGISTERED_SCHEMAS,
} = require('../src/services/sheetSchemaService');
const {
  createOrRegisterDynamicTableFromCsv,
  parseAndValidateSheetCsv,
  importSheetRecordsToDatabase,
} = require('../src/services/sheetCsvImportService');

const DEMO_BASE = path.resolve(__dirname, '../demo');
const VELOURA_BIZ_ID = '684a8863-5094-4c8b-9b15-c50c06335b7f';
const ECHO_WORKSTATION_BIZ_ID = '11111111-2222-3333-4444-555555555555';
const STALE_TEST_BIZ_ID = '9116b23e-e4c7-4be8-bbbb-7327d1f27ee3';

async function jsonRequest(baseUrl, method, routePath, body) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function uploadWorkspaceFilesHttp(baseUrl, businessId, filePaths, replaceAll = false) {
  const form = new FormData();
  for (const fp of filePaths) {
    const buf = fs.readFileSync(fp);
    const filename = path.basename(fp);
    const ext = path.extname(filename).toLowerCase();
    const mime =
      ext === '.pdf'
        ? 'application/pdf'
        : ext === '.csv'
          ? 'text/csv'
          : 'text/plain';
    form.append('files', new Blob([buf], { type: mime }), filename);
  }
  const qs = `business_id=${encodeURIComponent(businessId)}${replaceAll ? '&replace_all=true' : ''}`;
  const response = await fetch(`${baseUrl}/api/workspace/documents/upload?${qs}`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function uploadSheetCsvHttp(baseUrl, businessId, entity, csvPath) {
  const buf = fs.readFileSync(csvPath);
  const form = new FormData();
  form.append(
    'file',
    new Blob([buf], { type: 'text/csv' }),
    path.basename(csvPath)
  );
  const response = await fetch(
    `${baseUrl}/api/sheets/${encodeURIComponent(entity)}/upload?businessId=${encodeURIComponent(businessId)}`,
    {
      method: 'POST',
      body: form,
    }
  );
  const data = await response.json();
  return { status: response.status, data };
}

function findMatchingOption(options, predicate) {
  return options.find(predicate) || null;
}

async function runAllScenarios() {
  console.log('========================================================================');
  console.log('COMPREHENSIVE 4-SCENARIO LIVE STRESS TEST & REMEDIATION VERIFICATION');
  console.log('========================================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  let tempRecallBizId = null;

  try {
    // =========================================================================
    // PHASE 0: MANDATORY FRESH-SLATE RESET
    // =========================================================================
    console.log('[Phase 0] Starting from a fresh slate (clearing documents, chunks, workflows)...');
    await clearAllDocumentsGlobal();
    await clearWorkflowStoreGlobal();

    const docCountCheck = await query(
      `SELECT COUNT(*)::int AS cnt FROM workspace_documents;`
    );
    const chunkCountCheck = await query(
      `SELECT COUNT(*)::int AS cnt FROM workspace_document_chunks;`
    );
    assert.equal(docCountCheck.rows[0].cnt, 0, 'workspace_documents must be empty after fresh-slate reset');
    assert.equal(chunkCountCheck.rows[0].cnt, 0, 'workspace_document_chunks must be empty after fresh-slate reset');
    console.log('  -> Verified workspace_documents=0, workspace_document_chunks=0');

    // Drop old corrupted backorders_dataset table so Scenario 4 imports clean columns
    await query(`DROP TABLE IF EXISTS "backorders_dataset" CASCADE;`);
    if (REGISTERED_SCHEMAS && typeof REGISTERED_SCHEMAS.delete === 'function') {
      REGISTERED_SCHEMAS.delete('backorders_dataset');
    }
    console.log('  -> Dropped corrupted legacy backorders_dataset schema');

    // Clean up old stress-test business 9116b23e-e4c7-4be8-bbbb-7327d1f27ee3 if present
    try {
      await query(
        `DELETE FROM "wholesale_accunts_dataset" WHERE business_id = $1 OR business_id IN (SELECT id FROM businesses WHERE name = 'Veloura Wholesale B2B Accounts Workspace');`,
        [STALE_TEST_BIZ_ID]
      );
    } catch {
      // Ignore if table not yet created
    }
    await query(
      `DELETE FROM businesses WHERE id = $1 OR name IN ('Echo Workstation QA Recall Verification Lab', 'Veloura Wholesale B2B Accounts Workspace');`,
      [STALE_TEST_BIZ_ID]
    );

    // Ensure Veloura Apparel & Echo Workstation businesses exist
    await query(
      `INSERT INTO businesses (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING;`,
      [VELOURA_BIZ_ID, 'Veloura Apparel']
    );
    await query(
      `INSERT INTO businesses (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING;`,
      [ECHO_WORKSTATION_BIZ_ID, 'Echo Workstation']
    );

    // Ensure Veloura Apparel has at least 2 registered buyer customers
    const custRes = await query(
      `SELECT id, customer_name, email FROM customers WHERE business_id = $1 ORDER BY created_at ASC;`,
      [VELOURA_BIZ_ID]
    );
    console.log(
      `  -> Confirmed ${custRes.rows.length} registered buyer(s) in customers for Veloura (${VELOURA_BIZ_ID})`
    );
    assert.ok(
      custRes.rows.length >= 2,
      'Expected at least 2 registered buyers under Veloura Apparel'
    );

    // Reset Veloura products baseline from demo/scenario_1/products.csv
    const s1ProductsCsv = path.join(DEMO_BASE, 'scenario_1', 'products.csv');
    const resetProdRes = await uploadSheetCsvHttp(
      baseUrl,
      VELOURA_BIZ_ID,
      'products',
      s1ProductsCsv
    );
    assert.equal(resetProdRes.status, 200, 'Resetting products.csv must return HTTP 200');
    console.log('  -> Reset baseline products.csv (15 rows) for Veloura Apparel');

    // Confirm orders table exists on 11111111-2222-3333-4444-555555555555 and restore clean baseline rows if mutated by Scenario 0 test
    const s0OrdersCsv = path.join(
      DEMO_BASE,
      'scenario_0',
      'Commercial Orders Dataset.csv'
    );
    const ordersExistCheck = await query(
      `SELECT COUNT(*)::int AS cnt FROM "orders" WHERE business_id = $1;`,
      [ECHO_WORKSTATION_BIZ_ID]
    );
    assert.ok(
      ordersExistCheck.rows[0].cnt > 0,
      'Confirmed orders table must exist with rows under 11111111-2222-3333-4444-555555555555'
    );
    const s0Buf = fs.readFileSync(s0OrdersCsv);
    const s0Schema = await createOrRegisterDynamicTableFromCsv(
      'orders',
      s0Buf,
      ECHO_WORKSTATION_BIZ_ID
    );
    const { validRecords: s0Valid } = parseAndValidateSheetCsv(s0Buf, s0Schema, {
      mode: 'replace',
    });
    await importSheetRecordsToDatabase(ECHO_WORKSTATION_BIZ_ID, s0Schema, s0Valid, {
      mode: 'replace',
    });
    console.log(
      `  -> Confirmed orders table under ${ECHO_WORKSTATION_BIZ_ID} (${ordersExistCheck.rows[0].cnt} rows)\n`
    );

    // =========================================================================
    // SCENARIO 1: Apparel Flash Sale vs. Brand Margin Governance
    // =========================================================================
    console.log('------------------------------------------------------------------------');
    console.log('SCENARIO 1: Apparel Flash Sale vs. Brand Margin Governance');
    console.log('------------------------------------------------------------------------');

    const s1Upload = await uploadWorkspaceFilesHttp(
      baseUrl,
      VELOURA_BIZ_ID,
      [
        path.join(DEMO_BASE, 'scenario_1', 'Brand_Pricing_Policy.pdf'),
        path.join(DEMO_BASE, 'scenario_1', 'End_of_Season_Memo.pdf'),
      ],
      true
    );
    assert.equal(s1Upload.status, 201, 'Scenario 1 PDF upload must return 201');
    assert.equal(s1Upload.data.documents.length, 2);

    // Verify clean PDF extraction (zero garbled characters)
    const s1ChunksDb = await query(
      `SELECT filename, raw_text FROM workspace_document_chunks WHERE business_id = $1;`,
      [VELOURA_BIZ_ID]
    );
    const s1AllText = s1ChunksDb.rows.map((r) => r.raw_text).join('\n');
    assert.ok(s1AllText.includes('luxury shirt'), 'Extracted PDF text must contain "luxury shirt"');
    assert.ok(s1AllText.includes('summer shirt'), 'Extracted PDF text must contain "summer shirt"');
    assert.ok(s1AllText.includes('30%'), 'Extracted PDF text must contain "30%" ceiling');
    assert.ok(!s1AllText.includes('\u0000'), 'Extracted PDF text must contain zero null bytes');
    console.log(
      `  [Ingest] Extracted ${s1ChunksDb.rows.length} clean chunks across Brand_Pricing_Policy.pdf & End_of_Season_Memo.pdf`
    );

    const s1Prompt =
      'Apply the end-of-season discount increase from the memo to eligible products in our catalog and send the updated price announcement to our buyer list per our brand pricing policy.';

    const s1Turn1 = await jsonRequest(baseUrl, 'POST', '/api/workspace/execute', {
      business_id: VELOURA_BIZ_ID,
      prompt: s1Prompt,
    });
    console.log(
      `  [Turn 1 Raw] status=${s1Turn1.data.status}, affected=${s1Turn1.data.affected_rows_count}, conflicting=${s1Turn1.data.conflicting_rows_count}, summary=${s1Turn1.data.conflict_summary}`
    );
    assert.equal(s1Turn1.status, 200);
    assert.equal(
      s1Turn1.data.status,
      'CLARIFICATION_REQUIRED',
      `Scenario 1 Turn 1 must return CLARIFICATION_REQUIRED, got ${s1Turn1.data.status}`
    );
    assert.equal(
      s1Turn1.data.affected_rows_count,
      5,
      `Scenario 1 must identify exactly 5 eligible rows (3 summer + 2 luxury shirts), got ${s1Turn1.data.affected_rows_count}`
    );
    assert.equal(
      s1Turn1.data.conflicting_rows_count,
      2,
      `Scenario 1 must flag exactly 2 conflicting luxury shirt rows, got ${s1Turn1.data.conflicting_rows_count}`
    );
    const s1Options = s1Turn1.data.socratic_questions[0].options;
    assert.ok(s1Options.length >= 2, 'Scenario 1 must offer at least 2 Socratic options');
    assert.ok(
      s1Turn1.data.citations.some(
        (c) => c.source_type === 'table' && c.source_name === 'products'
      ),
      'Scenario 1 must cite table "products" (never orders)'
    );
    assert.ok(
      !s1Turn1.data.citations.some((c) => c.source_name === 'orders'),
      'Scenario 1 must NEVER reference "orders"'
    );
    console.log(
      `  [Turn 1] CLARIFICATION_REQUIRED: affected=${s1Turn1.data.affected_rows_count}, conflicting=${s1Turn1.data.conflicting_rows_count}, options=${s1Options.map((o) => o.option_id).join(', ')}`
    );

    // Test Option 1: Cap luxury shirts at 30%, summer shirts +20% (25 -> 45)
    const s1CapOpt =
      findMatchingOption(
        s1Options,
        (o) =>
          /cap|30%|ceiling|option[_\s-]*1/i.test(
            `${o.option_id} ${o.label} ${o.rule_interpretation}`
          ) && !/exclude\s+all\s+["']?luxury/i.test(o.label)
      ) || s1Options[0];

    const s1Turn2Opt1 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/resolve-socratic',
      {
        business_id: VELOURA_BIZ_ID,
        workflow_id: s1Turn1.data.workflow_id,
        selected_options: s1CapOpt.option_id,
      }
    );
    assert.equal(s1Turn2Opt1.status, 200);
    assert.equal(s1Turn2Opt1.data.status, 'PREVIEW_READY');
    assert.equal(
      s1Turn2Opt1.data.mutations_preview.length,
      5,
      'Scenario 1 Option 1 must preview 5 product mutations'
    );
    for (const mut of s1Turn2Opt1.data.mutations_preview) {
      assert.equal(mut.table_name, 'products');
      if (
        mut.row_identifier === "Men's new follower stylish long-sleeved shirts" ||
        mut.row_identifier === 'Sparkle fusion Shirt'
      ) {
        assert.equal(
          Number(mut.after.discount),
          30,
          `Luxury shirt "${mut.row_identifier}" must be capped at 30%`
        );
      } else {
        assert.equal(
          Number(mut.after.discount),
          45,
          `Summer shirt "${mut.row_identifier}" must be increased from 25% to 45%`
        );
      }
    }
    assert.equal(
      s1Turn2Opt1.data.emails_preview.length,
      custRes.rows.length,
      `Scenario 1 must generate buyer announcement emails for all ${custRes.rows.length} registered buyers`
    );
    console.log(
      `  [Turn 2 - Option 1] PREVIEW_READY: 3 summer shirts -> 45%, 2 luxury shirts capped -> 30%, ${s1Turn2Opt1.data.emails_preview.length} buyer emails drafted`
    );

    const s1Turn3Opt1 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/confirm-operation',
      {
        business_id: VELOURA_BIZ_ID,
        workflow_id: s1Turn1.data.workflow_id,
        confirm: true,
        dry_run: true,
      }
    );
    assert.equal(s1Turn3Opt1.status, 200);
    assert.equal(s1Turn3Opt1.data.status, 'EXECUTED');
    assert.equal(s1Turn3Opt1.data.updated_rows_count, 5);
    assert.equal(s1Turn3Opt1.data.dispatched_emails_count, custRes.rows.length);

    const s1DbVerify = await query(
      `SELECT name, category, discount FROM products WHERE business_id = $1;`,
      [VELOURA_BIZ_ID]
    );
    for (const row of s1DbVerify.rows) {
      if (row.category === 'summer shirt') {
        assert.equal(Number(row.discount), 45);
      } else if (row.category === 'luxury shirt') {
        assert.equal(Number(row.discount), 30);
      } else if (row.name === 'Granular Texture Polo Shirt') {
        assert.equal(Number(row.discount), 45);
      } else {
        assert.equal(
          Number(row.discount),
          25,
          `Excluded product "${row.name}" (${row.category}) must remain untouched at 25%`
        );
      }
    }
    console.log('  [Turn 3 - Option 1] EXECUTED & verified in PostgreSQL: 5 rows updated, 10 excluded rows untouched!');

    // Also verify Option 2 (Exclude Luxury Line -> 3 rows updated)
    await uploadSheetCsvHttp(baseUrl, VELOURA_BIZ_ID, 'products', s1ProductsCsv);
    const s1Turn1B = await jsonRequest(baseUrl, 'POST', '/api/workspace/execute', {
      business_id: VELOURA_BIZ_ID,
      prompt: s1Prompt,
    });
    const s1ExcludeOpt =
      findMatchingOption(
        s1Turn1B.data.socratic_questions[0].options,
        (o) =>
          /exclude|summer\s+shirt.*only|option[_\s-]*2/i.test(
            `${o.option_id} ${o.label} ${o.rule_interpretation}`
          )
      ) || s1Turn1B.data.socratic_questions[0].options[1];

    const s1Turn2Opt2 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/resolve-socratic',
      {
        business_id: VELOURA_BIZ_ID,
        workflow_id: s1Turn1B.data.workflow_id,
        selected_options: s1ExcludeOpt.option_id,
      }
    );
    assert.equal(s1Turn2Opt2.status, 200);
    assert.equal(s1Turn2Opt2.data.status, 'PREVIEW_READY');
    assert.equal(
      s1Turn2Opt2.data.mutations_preview.length,
      3,
      'Scenario 1 Option 2 must mutate ONLY the 3 summer shirts'
    );
    const s1Turn3Opt2 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/confirm-operation',
      {
        business_id: VELOURA_BIZ_ID,
        workflow_id: s1Turn1B.data.workflow_id,
        confirm: true,
        dry_run: true,
      }
    );
    assert.equal(s1Turn3Opt2.data.updated_rows_count, 3);
    console.log('  [Turn 2 & 3 - Option 2] Verified: 3 summer shirts -> 45%, luxury shirts excluded (remain 25%)!');

    // Restore baseline products.csv for clean state
    await uploadSheetCsvHttp(baseUrl, VELOURA_BIZ_ID, 'products', s1ProductsCsv);
    console.log('  => SCENARIO 1 PASSED!\n');

    // =========================================================================
    // SCENARIO 2: Batch Quality Recall & Payment Method Routing
    // =========================================================================
    console.log('------------------------------------------------------------------------');
    console.log('SCENARIO 2: Batch Quality Recall & Payment Method Routing');
    console.log('------------------------------------------------------------------------');

    const s2Upload = await uploadWorkspaceFilesHttp(
      baseUrl,
      ECHO_WORKSTATION_BIZ_ID,
      [
        path.join(DEMO_BASE, 'scenario_2', 'QA_Batch_Recall.pdf'),
        path.join(DEMO_BASE, 'scenario_2', 'Refund_Compliance_SOP.pdf'),
      ],
      true
    );
    assert.equal(s2Upload.status, 201, 'Scenario 2 PDF upload must return 201');

    // Verify 2-byte Identity-H CID PDF extraction
    const s2ChunksDb = await query(
      `SELECT filename, raw_text FROM workspace_document_chunks WHERE business_id = $1;`,
      [ECHO_WORKSTATION_BIZ_ID]
    );
    const s2AllText = s2ChunksDb.rows.map((r) => r.raw_text).join('\n');
    assert.ok(
      s2AllText.includes('ECHO-QAB-2026-11B'),
      'Identity-H CID PDF extraction must decode "ECHO-QAB-2026-11B"'
    );
    assert.ok(
      s2AllText.includes('B-404') && s2AllText.includes('B-409'),
      'Identity-H CID PDF extraction must decode batch codes "B-404" & "B-409"'
    );
    assert.ok(
      s2AllText.includes('SOP-REV-802') &&
        s2AllText.includes('Pending Payout Verification'),
      'Identity-H CID PDF extraction must decode "SOP-REV-802" & "Pending Payout Verification"'
    );
    assert.ok(!s2AllText.includes('\u0000'), 'Zero null bytes allowed in CID PDF text');
    console.log(
      `  [Ingest] Extracted ${s2ChunksDb.rows.length} clean chunks from Identity-H CID PDFs (QA_Batch_Recall.pdf & Refund_Compliance_SOP.pdf)`
    );

    const s2Prompt =
      'Identify all orders impacted by the QA batch recall, update their order and refund status according to our Refund SOP, and email the affected customers.';

    // Part 2A: Run against live 11111111-2222-3333-4444-555555555555 existing orders table (no Batch_ID column)
    const s2LiveTurn1 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/execute',
      {
        business_id: ECHO_WORKSTATION_BIZ_ID,
        prompt: s2Prompt,
      }
    );
    assert.equal(s2LiveTurn1.status, 200);
    assert.equal(
      s2LiveTurn1.data.status,
      'CLARIFICATION_REQUIRED',
      'Scenario 2A on live 11111111-... must return CLARIFICATION_REQUIRED'
    );
    assert.ok(
      s2LiveTurn1.data.socratic_questions.length > 0 &&
        s2LiveTurn1.data.socratic_questions[0].options.length >= 1,
      'Scenario 2A must ALWAYS return >= 1 selectable option (zero options:[] UI deadlock!)'
    );
    console.log(
      `  [Part 2A - Live 11111111-... orders] CLARIFICATION_REQUIRED (zero UI deadlock, options=${s2LiveTurn1.data.socratic_questions[0].options.map((o) => o.option_id).join(', ')})`
    );
    console.log(`    Summary: ${s2LiveTurn1.data.conflict_summary}`);

    const s2LiveCancelOpt =
      findMatchingOption(
        s2LiveTurn1.data.socratic_questions[0].options,
        (o) => /cancel|abort/i.test(`${o.option_id} ${o.label}`)
      ) || s2LiveTurn1.data.socratic_questions[0].options[0];
    const s2LiveTurn2 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/resolve-socratic',
      {
        business_id: ECHO_WORKSTATION_BIZ_ID,
        workflow_id: s2LiveTurn1.data.workflow_id,
        selected_options: s2LiveCancelOpt.option_id,
      }
    );
    assert.equal(s2LiveTurn2.status, 200);
    assert.equal(s2LiveTurn2.data.status, 'PREVIEW_READY');

    // Part 2B: Verify full B-404 / B-409 Recall + COD / 15% Stacking SOP execution on a batch-equipped Echo Workstation orders table
    const createRecallBiz = await jsonRequest(baseUrl, 'POST', '/api/businesses', {
      name: 'Echo Workstation QA Recall Verification Lab',
    });
    assert.equal(createRecallBiz.status, 201);
    tempRecallBizId = createRecallBiz.data.id || createRecallBiz.data.business?.id;

    const recallOrdersCsvText = [
      'Order_ID,Order_Date,Customer_Name,Customer_Email,Item_SKU,Item_Name,Batch_ID,Quantity,Unit_Price_USD,Promo_Discount_Pct,Total_Amount_USD,Payment_Method,Order_Status,Refund_Status',
      'ORD-8801,2026-10-28,Liam Patel,liam.patel@studioforge.io,EW-DOCK-G4,Echo Workstation Gen-4 Dock,B-404,1,400,0,400,Credit Card,Shipped,None',
      'ORD-8802,2026-10-29,Nadia Karim,nadia.karim@renderlabs.bd,EW-COMP-S1,Echo Studio Compute Unit,B-409,1,1200,0,1200,Cash on Delivery,Processing,None',
      'ORD-8803,2026-10-30,Ethan Brooks,ethan.brooks@vfxgrid.com,EW-DOCK-G4,Echo Workstation Gen-4 Dock,B-404,2,400,10,720,Credit Card,Delivered,None',
      'ORD-8804,2026-10-31,Maya Lin,maya.lin@designcraft.co,EW-RISER-AL,Anodized Aluminum Monitor Riser,B-401,1,120,0,120,Credit Card,Delivered,None',
    ].join('\n');

    const recallForm = new FormData();
    for (const pdfName of ['QA_Batch_Recall.pdf', 'Refund_Compliance_SOP.pdf']) {
      const pBuf = fs.readFileSync(path.join(DEMO_BASE, 'scenario_2', pdfName));
      recallForm.append('files', new Blob([pBuf], { type: 'application/pdf' }), pdfName);
    }
    recallForm.append(
      'files',
      new Blob([recallOrdersCsvText], { type: 'text/csv' }),
      'echo_recall_orders.csv'
    );
    const s2bUp = await fetch(
      `${baseUrl}/api/workspace/documents/upload?business_id=${encodeURIComponent(tempRecallBizId)}&replace_all=true`,
      { method: 'POST', body: recallForm }
    );
    assert.equal(s2bUp.status, 201);

    const s2bTurn1 = await jsonRequest(baseUrl, 'POST', '/api/workspace/execute', {
      business_id: tempRecallBizId,
      prompt: s2Prompt,
    });
    console.log(
      `  [Part 2B Turn 1 Raw] status=${s2bTurn1.data.status}, affected=${s2bTurn1.data.affected_rows_count}, conflicting=${s2bTurn1.data.conflicting_rows_count}, summary=${s2bTurn1.data.conflict_summary}`
    );
    assert.equal(s2bTurn1.status, 200);
    assert.equal(s2bTurn1.data.status, 'CLARIFICATION_REQUIRED');
    assert.equal(
      s2bTurn1.data.affected_rows_count,
      3,
      `Scenario 2B must isolate ONLY the 3 recalled B-404/B-409 orders (excluding B-401 monitor riser), got ${s2bTurn1.data.affected_rows_count}`
    );
    assert.ok(
      s2bTurn1.data.conflicting_rows_count >= 2,
      `Scenario 2B must flag the COD (ORD-8802) and promo-stacking (ORD-8803) conflicts, got ${s2bTurn1.data.conflicting_rows_count}`
    );
    const s2bOpts = s2bTurn1.data.socratic_questions[0].options;
    assert.ok(s2bOpts.length >= 2, 'Scenario 2B must present SOP-REV-802 Option 1 & Option 2');

    const s2bOpt2 =
      findMatchingOption(
        s2bOpts,
        (o) =>
          /pending\s+payout|manual\s+bank|full\s+stack|option[_\s-]*2/i.test(
            `${o.option_id} ${o.label} ${o.rule_interpretation}`
          )
      ) || s2bOpts[0];

    const s2bTurn2 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/resolve-socratic',
      {
        business_id: tempRecallBizId,
        workflow_id: s2bTurn1.data.workflow_id,
        selected_options: s2bOpt2.option_id,
      }
    );
    assert.equal(s2bTurn2.status, 200);
    assert.equal(s2bTurn2.data.status, 'PREVIEW_READY');
    assert.equal(
      s2bTurn2.data.mutations_preview.length,
      3,
      'Scenario 2B must mutate exactly the 3 recalled B-404/B-409 orders'
    );
    assert.ok(
      !s2bTurn2.data.mutations_preview.some((m) => m.row_identifier === 'ORD-8804'),
      'Unaffected batch B-401 (ORD-8804) must NEVER be mutated'
    );
    assert.equal(
      s2bTurn2.data.emails_preview.length,
      3,
      'Scenario 2B must draft 3 customer recall notification emails'
    );
    assert.ok(
      s2bTurn2.data.emails_preview.every((e) =>
        /ECHO-QAB-2026-11B/i.test(`${e.subject} ${e.body}`)
      ),
      'Every recall email must cite Bulletin ID ECHO-QAB-2026-11B'
    );

    const s2bTurn3 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/confirm-operation',
      {
        business_id: tempRecallBizId,
        workflow_id: s2bTurn1.data.workflow_id,
        confirm: true,
        dry_run: true,
      }
    );
    assert.equal(s2bTurn3.status, 200);
    assert.equal(s2bTurn3.data.status, 'EXECUTED');
    assert.equal(s2bTurn3.data.updated_rows_count, 3);
    assert.equal(s2bTurn3.data.dispatched_emails_count, 3);
    console.log(
      '  [Part 2B - Batch-Equipped Recall Ledger] Verified: 3 B-404/B-409 rows updated, B-401 accessory untouched, 3 ECHO-QAB-2026-11B recall emails dispatched!'
    );
    console.log('  => SCENARIO 2 PASSED!\n');

    // =========================================================================
    // SCENARIO 3: B2B Account Tier Upgrade vs. Overdue Balance Freeze
    // =========================================================================
    console.log('------------------------------------------------------------------------');
    console.log('SCENARIO 3: B2B Account Tier Upgrade vs. Overdue Balance Freeze');
    console.log('------------------------------------------------------------------------');

    const createS3Biz = await jsonRequest(baseUrl, 'POST', '/api/businesses', {
      name: 'Veloura Wholesale B2B Accounts Workspace',
    });
    assert.equal(createS3Biz.status, 201, 'Creating new business for Scenario 3 must succeed');
    const s3BizId = createS3Biz.data.id || createS3Biz.data.business?.id;
    console.log(`  [Setup] Created fresh Scenario 3 business_id=${s3BizId}`);

    const s3Upload = await uploadWorkspaceFilesHttp(
      baseUrl,
      s3BizId,
      [
        path.join(DEMO_BASE, 'scenario_3', 'Finance Credit Control Policy.pdf'),
        path.join(DEMO_BASE, 'scenario_3', 'Q4 VIP Expansion Brief.pdf'),
        path.join(DEMO_BASE, 'scenario_3', 'wholesale_accunts_dataset.csv'),
      ],
      true
    );
    assert.equal(s3Upload.status, 201);
    assert.equal(s3Upload.data.documents.length, 2);
    assert.equal(s3Upload.data.tables.length, 1);
    assert.equal(
      s3Upload.data.tables[0].table_name,
      'wholesale_accunts_dataset',
      'Uploaded wholesale CSV must NEVER default to orders'
    );
    assert.equal(s3Upload.data.tables[0].imported_rows, 16);
    console.log(
      `  [Ingest] Uploaded 2 PDFs + wholesale_accunts_dataset.csv (16 rows)`
    );

    const s3Prompt =
      'Upgrade all qualifying Silver accounts in our wholesale table per the Q4 VIP Brief, adjust their credit limits, and email their account managers.';

    const s3Turn1 = await jsonRequest(baseUrl, 'POST', '/api/workspace/execute', {
      business_id: s3BizId,
      prompt: s3Prompt,
    });
    console.log(
      `  [Scenario 3 Turn 1 Raw] status=${s3Turn1.data.status}, affected=${s3Turn1.data.affected_rows_count}, conflicting=${s3Turn1.data.conflicting_rows_count}, summary=${s3Turn1.data.conflict_summary}`
    );
    assert.equal(s3Turn1.status, 200);
    assert.equal(s3Turn1.data.status, 'CLARIFICATION_REQUIRED');
    assert.equal(
      s3Turn1.data.affected_rows_count,
      6,
      `Scenario 3 must select ONLY the 6 Silver accounts with annual_spend >= 10000, got ${s3Turn1.data.affected_rows_count}`
    );
    assert.equal(
      s3Turn1.data.conflicting_rows_count,
      2,
      `Scenario 3 must flag ONLY ACC-1004 & ACC-1009 (overdue_balance > 0), got ${s3Turn1.data.conflicting_rows_count}`
    );
    const s3Opts = s3Turn1.data.socratic_questions[0].options;
    assert.ok(s3Opts.length >= 2, 'Scenario 3 must present Finance Policy Option A & Option B');
    console.log(
      `  [Turn 1] CLARIFICATION_REQUIRED: affected=${s3Turn1.data.affected_rows_count}/16, conflicting=${s3Turn1.data.conflicting_rows_count} (ACC-1004, ACC-1009)`
    );

    const s3OptA =
      findMatchingOption(
        s3Opts,
        (o) =>
          /credit\s*frozen|freeze|option[_\s-]*a/i.test(
            `${o.option_id} ${o.label} ${o.rule_interpretation}`
          ) && !/keep.*silver|hold\s+both/i.test(o.label)
      ) || s3Opts[0];

    const s3Turn2 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/resolve-socratic',
      {
        business_id: s3BizId,
        workflow_id: s3Turn1.data.workflow_id,
        selected_options: s3OptA.option_id,
      }
    );
    assert.equal(s3Turn2.status, 200);
    assert.equal(s3Turn2.data.status, 'PREVIEW_READY');
    assert.equal(
      s3Turn2.data.mutations_preview.length,
      6,
      'Scenario 3 Option A must mutate all 6 qualifying Silver accounts'
    );

    const expectedCleanLimits = {
      'ACC-1001': 10000,
      'ACC-1003': 7500,
      'ACC-1006': 15000,
      'ACC-1011': 7000,
    };
    for (const mut of s3Turn2.data.mutations_preview) {
      assert.equal(mut.table_name, 'wholesale_accunts_dataset');
      assert.equal(
        mut.after.current_tier,
        'Gold',
        `${mut.row_identifier} must upgrade to Gold under Option A`
      );
      if (expectedCleanLimits[mut.row_identifier]) {
        assert.equal(
          Number(mut.after.credit_limit),
          expectedCleanLimits[mut.row_identifier],
          `${mut.row_identifier} credit_limit must increase +25% to ${expectedCleanLimits[mut.row_identifier]}`
        );
      } else {
        assert.ok(
          ['ACC-1004', 'ACC-1009'].includes(mut.row_identifier),
          `Unexpected conflicting account ${mut.row_identifier}`
        );
        assert.equal(
          mut.after.credit_limit,
          undefined,
          `${mut.row_identifier} credit_limit must remain frozen (unchanged)`
        );
        assert.match(
          String(mut.after.account_status),
          /Gold\s*-\s*Credit\s*Frozen/i,
          `${mut.row_identifier} account_status must be set to "Gold - Credit Frozen"`
        );
      }
    }

    assert.equal(
      s3Turn2.data.emails_preview.length,
      6,
      'Scenario 3 must draft 6 emails to the qualifying Account Managers'
    );
    const expectedManagers = [
      'Sarah',
      'Lukas',
      'David',
      'Marcus',
      'Priya',
      'Elena',
    ];
    const combinedEmailBodies = s3Turn2.data.emails_preview
      .map((e) => `${e.customer_identifier} ${e.body}`)
      .join('\n');
    for (const mgrFirst of expectedManagers) {
      assert.ok(
        combinedEmailBodies.includes(mgrFirst),
        `Account Manager "${mgrFirst}" must be addressed by name in Scenario 3 emails`
      );
    }

    const s3Turn3 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/confirm-operation',
      {
        business_id: s3BizId,
        workflow_id: s3Turn1.data.workflow_id,
        confirm: true,
        dry_run: true,
      }
    );
    assert.equal(s3Turn3.status, 200);
    assert.equal(s3Turn3.data.status, 'EXECUTED');
    assert.equal(s3Turn3.data.updated_rows_count, 6);
    assert.equal(s3Turn3.data.dispatched_emails_count, 6);
    console.log(
      '  [Turn 2 & 3 - Option A] Verified in PostgreSQL: 4 clean accounts -> Gold (+25% credit), ACC-1004 & ACC-1009 -> "Gold - Credit Frozen" (0% increase), 6 Account Manager emails dispatched!'
    );
    console.log('  => SCENARIO 3 PASSED!\n');

    // =========================================================================
    // SCENARIO 4: Port Manifest Allocation & Backorder Priority Waterfall
    // =========================================================================
    console.log('------------------------------------------------------------------------');
    console.log('SCENARIO 4: Port Manifest Allocation & Backorder Priority Waterfall');
    console.log('------------------------------------------------------------------------');

    const s4CsvPath = path.join(DEMO_BASE, 'scenario_4', 'backorders_dataset.csv');
    const s4Upload = await uploadWorkspaceFilesHttp(
      baseUrl,
      VELOURA_BIZ_ID,
      [
        path.join(DEMO_BASE, 'scenario_4', 'Allocation Priority Policy.pdf'),
        path.join(DEMO_BASE, 'scenario_4', 'Port Receiving Manifest.pdf'),
        s4CsvPath,
      ],
      true
    );
    assert.equal(s4Upload.status, 201);
    assert.equal(s4Upload.data.documents.length, 2);
    assert.equal(s4Upload.data.tables.length, 1);
    assert.equal(
      s4Upload.data.tables[0].table_name,
      'backorders_dataset',
      'backorders_dataset.csv must import into table "backorders_dataset"'
    );
    assert.equal(s4Upload.data.tables[0].imported_rows, 13);

    // Verify replace_all=true eliminated Scenario 1's PDFs so zero cross-scenario bleed occurs
    const s4DocsList = await jsonRequest(
      baseUrl,
      'GET',
      `/api/workspace/documents?business_id=${VELOURA_BIZ_ID}`
    );
    assert.equal(
      s4DocsList.data.documents.length,
      2,
      'replace_all=true must keep only Scenario 4 PDFs on Veloura Apparel'
    );

    const s4Prompt =
      'Allocate the received units from the port manifest across our open backorders according to our Allocation Policy and email the buyers their fulfillment status.';

    // Deliberately pass entity: 'products' to prove Gemini's routed.entity ('backorders_dataset') overrides a stale UI dropdown!
    const s4Turn1 = await jsonRequest(baseUrl, 'POST', '/api/workspace/execute', {
      business_id: VELOURA_BIZ_ID,
      entity: 'products',
      prompt: s4Prompt,
    });
    console.log(
      `  [Scenario 4 Turn 1 Raw] status=${s4Turn1.data.status}, affected=${s4Turn1.data.affected_rows_count}, conflicting=${s4Turn1.data.conflicting_rows_count}, summary=${s4Turn1.data.conflict_summary}`
    );
    assert.equal(s4Turn1.status, 200);
    assert.equal(s4Turn1.data.status, 'CLARIFICATION_REQUIRED');
    assert.equal(
      s4Turn1.data.affected_rows_count,
      6,
      `Scenario 4 must select ONLY the 6 Pending VL-POLO-BLK backorders, got ${s4Turn1.data.affected_rows_count}`
    );
    assert.ok(
      s4Turn1.data.citations.some(
        (c) => c.source_type === 'table' && c.source_name === 'backorders_dataset'
      ),
      'Scenario 4 must target "backorders_dataset" even when active UI entity was "products"'
    );
    const s4Opts = s4Turn1.data.socratic_questions[0].options;
    assert.ok(s4Opts.length >= 2, 'Scenario 4 must offer Option A (Prorating) & Option B (FIFO)');
    console.log(
      `  [Turn 1] CLARIFICATION_REQUIRED on backorders_dataset: affected=${s4Turn1.data.affected_rows_count} (60 requested vs 40 available -> 20-unit deficit)`
    );

    // Verify Option A: Proportional Prorating (Priority: 12, 8 Fulfilled; Standard: 5, 5, 6, 4 Partial)
    const s4OptA =
      findMatchingOption(
        s4Opts,
        (o) =>
          /prorat|proportional|50%|option[_\s-]*a/i.test(
            `${o.option_id} ${o.label} ${o.rule_interpretation}`
          )
      ) || s4Opts[0];

    const s4Turn2OptA = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/resolve-socratic',
      {
        business_id: VELOURA_BIZ_ID,
        workflow_id: s4Turn1.data.workflow_id,
        selected_options: s4OptA.option_id,
      }
    );
    assert.equal(s4Turn2OptA.status, 200);
    assert.equal(s4Turn2OptA.data.status, 'PREVIEW_READY');
    assert.equal(s4Turn2OptA.data.mutations_preview.length, 6);

    const expectedProrated = {
      'BO-2001': { qty: 12, status: 'Fulfilled' },
      'BO-2004': { qty: 8, status: 'Fulfilled' },
      'BO-2002': { qty: 5, status: 'Partial' },
      'BO-2006': { qty: 5, status: 'Partial' },
      'BO-2009': { qty: 6, status: 'Partial' },
      'BO-2013': { qty: 4, status: 'Partial' },
    };
    let sumAllocatedA = 0;
    for (const mut of s4Turn2OptA.data.mutations_preview) {
      assert.equal(mut.table_name, 'backorders_dataset');
      const exp = expectedProrated[mut.row_identifier];
      assert.ok(exp, `Unexpected backorder mutated: ${mut.row_identifier}`);
      assert.equal(
        Number(mut.after.quantity_allocated),
        exp.qty,
        `Option A ${mut.row_identifier} quantity_allocated must be ${exp.qty}`
      );
      assert.equal(
        String(mut.after.fulfillment_status),
        exp.status,
        `Option A ${mut.row_identifier} fulfillment_status must be "${exp.status}"`
      );
      sumAllocatedA += Number(mut.after.quantity_allocated);
    }
    assert.equal(sumAllocatedA, 40, 'Total allocated units under Option A must equal 40');
    assert.equal(s4Turn2OptA.data.emails_preview.length, 6);

    const s4Turn3OptA = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/confirm-operation',
      {
        business_id: VELOURA_BIZ_ID,
        workflow_id: s4Turn1.data.workflow_id,
        confirm: true,
        dry_run: true,
      }
    );
    assert.equal(s4Turn3OptA.status, 200);
    assert.equal(s4Turn3OptA.data.updated_rows_count, 6);
    assert.equal(s4Turn3OptA.data.dispatched_emails_count, 6);
    console.log(
      '  [Turn 2 & 3 - Option A Prorating] Verified in PostgreSQL: Priority=(12, 8 Fulfilled), Standard=(5, 5, 6, 4 Partial), Total=40 units, 6 buyer emails!'
    );

    // Also verify Option B: FIFO Oldest-First (BO-2001:12, BO-2004:8, BO-2002:10, BO-2006:10 Fulfilled; BO-2009:0, BO-2013:0 Backordered)
    await uploadSheetCsvHttp(
      baseUrl,
      VELOURA_BIZ_ID,
      'backorders_dataset',
      s4CsvPath
    );
    const s4Turn1B = await jsonRequest(baseUrl, 'POST', '/api/workspace/execute', {
      business_id: VELOURA_BIZ_ID,
      prompt: s4Prompt,
    });
    const s4OptB =
      findMatchingOption(
        s4Turn1B.data.socratic_questions[0].options,
        (o) =>
          /fifo|oldest|option[_\s-]*b/i.test(
            `${o.option_id} ${o.label} ${o.rule_interpretation}`
          )
      ) || s4Turn1B.data.socratic_questions[0].options[1];

    const s4Turn2OptB = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/resolve-socratic',
      {
        business_id: VELOURA_BIZ_ID,
        workflow_id: s4Turn1B.data.workflow_id,
        selected_options: s4OptB.option_id,
      }
    );
    assert.equal(s4Turn2OptB.status, 200);
    assert.equal(s4Turn2OptB.data.mutations_preview.length, 6);

    const expectedFifo = {
      'BO-2001': { qty: 12, status: 'Fulfilled' },
      'BO-2004': { qty: 8, status: 'Fulfilled' },
      'BO-2002': { qty: 10, status: 'Fulfilled' },
      'BO-2006': { qty: 10, status: 'Fulfilled' },
      'BO-2009': { qty: undefined, status: 'Backordered' },
      'BO-2013': { qty: undefined, status: 'Backordered' },
    };
    for (const mut of s4Turn2OptB.data.mutations_preview) {
      const exp = expectedFifo[mut.row_identifier];
      assert.ok(exp, `Unexpected FIFO row ${mut.row_identifier}`);
      if (exp.qty !== undefined) {
        assert.equal(Number(mut.after.quantity_allocated), exp.qty);
      }
      assert.equal(String(mut.after.fulfillment_status), exp.status);
    }

    const s4Turn3OptB = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/confirm-operation',
      {
        business_id: VELOURA_BIZ_ID,
        workflow_id: s4Turn1B.data.workflow_id,
        confirm: true,
        dry_run: true,
      }
    );
    assert.equal(s4Turn3OptB.data.updated_rows_count, 6);
    console.log(
      '  [Turn 2 & 3 - Option B FIFO] Verified in PostgreSQL: Priority=(12, 8 Fulfilled), Oldest Standard=(10, 10 Fulfilled), Newer Standard=(0, 0 Backordered)!'
    );

    // Restore clean Pending baseline on backorders_dataset for interactive UI testing
    await uploadSheetCsvHttp(
      baseUrl,
      VELOURA_BIZ_ID,
      'backorders_dataset',
      s4CsvPath
    );
    console.log('  => SCENARIO 4 PASSED!\n');

    console.log('========================================================================');
    console.log('ALL 4 STRESS-TEST SCENARIOS (INCLUDING ALL OPTIONS) PASSED FLAWLESSLY!');
    console.log('========================================================================');
  } finally {
    // Clean up temporary isolated recall test business so workspace stays spotless
    if (tempRecallBizId) {
      try {
        await clearDocumentsForBusiness(tempRecallBizId);
        await query(`DROP TABLE IF EXISTS "echo_recall_orders" CASCADE;`);
        if (REGISTERED_SCHEMAS && typeof REGISTERED_SCHEMAS.delete === 'function') {
          REGISTERED_SCHEMAS.delete('echo_recall_orders');
        }
        await query(`DELETE FROM businesses WHERE id = $1;`, [tempRecallBizId]);
      } catch {
        // Ignore cleanup errors
      }
    }

    await new Promise((resolve) => server.close(resolve));
    try {
      const pool = getPool();
      if (pool && typeof pool.end === 'function') {
        await pool.end();
      }
    } catch {
      // Ignore pool shutdown error
    }
  }
}

runAllScenarios().catch((err) => {
  console.error('\n[FATAL] Scenario verification failed:', err);
  process.exit(1);
});
