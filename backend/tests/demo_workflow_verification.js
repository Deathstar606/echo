const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const app = require('../src/app');
const { query, getPool } = require('../db');
const {
  ingestDocument,
  clearDocumentsForBusiness,
} = require('../src/services/documentIngestionService');
const {
  createOrRegisterDynamicTableFromCsv,
  parseAndValidateSheetCsv,
  importSheetRecordsToDatabase,
} = require('../src/services/sheetCsvImportService');
const {
  getDispatchedWorkspaceEmails,
} = require('../src/services/socraticOperationsService');
const {
  setWorkspaceGeminiGenerator,
  generateStructuredJsonWithRetry,
} = require('../src/services/geminiService');

const DEMO_ROOT = path.resolve(__dirname, '../demo');
const DEMO_DIR = fs.existsSync(path.join(DEMO_ROOT, 'scenario_0'))
  ? path.join(DEMO_ROOT, 'scenario_0')
  : DEMO_ROOT;
const TEST_BUSINESS_ID = '11111111-2222-3333-4444-555555555555';

async function jsonRequest(baseUrl, method, routePath, body) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function runVerification() {
  console.log('======================================================================');
  console.log('PHASE 4: CROSS-DOCUMENT HYBRID RAG & SOCRATIC GATE VERIFICATION');
  console.log('======================================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // -------------------------------------------------------------------------
    // STEP 0: Clean up previous test state & dynamically load ./backend/demo assets
    // -------------------------------------------------------------------------
    await clearDocumentsForBusiness(TEST_BUSINESS_ID);

    await query(
      `
        INSERT INTO businesses (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO NOTHING;
      `,
      [TEST_BUSINESS_ID, 'Echo Demo Operations Workspace']
    );

    const demoFiles = fs.readdirSync(DEMO_DIR);
    console.log(`[Step 0] Discovered ./backend/demo assets: ${demoFiles.join(', ')}`);

    const pdfFiles = demoFiles.filter((f) => f.toLowerCase().endsWith('.pdf'));
    const csvFiles = demoFiles.filter((f) => f.toLowerCase().endsWith('.csv'));

    assert.ok(pdfFiles.length >= 2, 'Expected at least 2 PDF files in ./backend/demo');
    assert.ok(csvFiles.length >= 1, 'Expected at least 1 CSV file in ./backend/demo');

    for (const pdfFile of pdfFiles) {
      const fullPath = path.join(DEMO_DIR, pdfFile);
      const buffer = fs.readFileSync(fullPath);
      const docRecord = await ingestDocument({
        businessId: TEST_BUSINESS_ID,
        filename: pdfFile,
        buffer,
      });
      console.log(
        `  -> Ingested PDF "${docRecord.filename}" (pages=${docRecord.page_count}, chunks=${docRecord.chunk_count})`
      );
      assert.ok(docRecord.chunk_count > 0, `Expected chunks > 0 for ${pdfFile}`);
    }

    const ordersCsvFile = csvFiles[0];
    const ordersBuffer = fs.readFileSync(path.join(DEMO_DIR, ordersCsvFile));
    const ordersSchema = await createOrRegisterDynamicTableFromCsv(
      'orders',
      ordersBuffer,
      TEST_BUSINESS_ID
    );
    const { validRecords, totalRows } = parseAndValidateSheetCsv(
      ordersBuffer,
      ordersSchema,
      { mode: 'replace' }
    );
    const importedCount = await importSheetRecordsToDatabase(
      TEST_BUSINESS_ID,
      ordersSchema,
      validRecords,
      { mode: 'replace' }
    );
    console.log(
      `  -> Imported CSV "${ordersCsvFile}" into table "${ordersSchema.tableName}" (rows=${importedCount}/${totalRows})\n`
    );
    assert.equal(importedCount, 20, 'Expected all 20 rows from Commercial Orders Dataset.csv to be imported');

    // -------------------------------------------------------------------------
    // STEP 0.5: Verify Graceful Conversational Fallback & Self-Correction Retry
    // -------------------------------------------------------------------------
    const convRes = await jsonRequest(baseUrl, 'POST', '/api/workspace/execute', {
      business_id: TEST_BUSINESS_ID,
      prompt: 'Hello',
    });
    assert.equal(convRes.status, 200);
    assert.equal(convRes.data.conversational, true);
    console.log('[Check] Graceful conversational fallback for 1-word greeting ("Hello"): PASSED');

    let retryAttempts = 0;
    setWorkspaceGeminiGenerator(async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        return 'not-valid-json {{{';
      }
      return JSON.stringify({ ok: true, attempt: retryAttempts });
    });
    const retryResult = await generateStructuredJsonWithRetry(
      'Return JSON',
      (parsed) => {
        if (!parsed.ok) throw new Error('Missing ok flag');
        return parsed;
      },
      { maxRetries: 2 }
    );
    setWorkspaceGeminiGenerator(null);
    assert.equal(retryResult.ok, true);
    assert.equal(retryAttempts, 2);
    console.log('[Check] LLM Structured JSON Self-Correction Retry (recovered on retry #1): PASSED\n');

    // -------------------------------------------------------------------------
    // TURN 1: Initial Prompt -> STATE 1: CLARIFICATION_REQUIRED (Socratic Gate)
    // -------------------------------------------------------------------------
    const instructionPrompt =
      'Cross-reference the Supplier Delay Notice and Fulfillment SLA Policy with the orders table, update delayed orders exceeding the SLA threshold, apply the policy store credit voucher compensation, and send notification emails to affected customers.';

    console.log(`[Turn 1] Submitting natural language instruction:\n  "${instructionPrompt}"`);
    const turn1 = await jsonRequest(baseUrl, 'POST', '/api/workspace/execute', {
      business_id: TEST_BUSINESS_ID,
      entity: 'orders',
      prompt: instructionPrompt,
    });

    assert.equal(turn1.status, 200, 'Expected HTTP 200 on Turn 1');
    const turn1Payload = turn1.data;
    console.log(`[Turn 1] Response status: ${turn1Payload.status}`);
    console.log(`[Turn 1] Workflow ID: ${turn1Payload.workflow_id}`);
    console.log(`[Turn 1] Conflict Summary: ${turn1Payload.conflict_summary}`);
    console.log(
      `[Turn 1] Affected Rows: ${turn1Payload.affected_rows_count}, Conflicting Rows: ${turn1Payload.conflicting_rows_count}`
    );

    assert.equal(
      turn1Payload.status,
      'CLARIFICATION_REQUIRED',
      'Turn 1 must trigger CLARIFICATION_REQUIRED'
    );
    assert.ok(turn1Payload.workflow_id, 'Turn 1 must return a workflow_id');
    assert.ok(
      turn1Payload.conflicting_rows_count > 0,
      'Turn 1 must detect conflicting_rows_count > 0'
    );
    assert.ok(
      Array.isArray(turn1Payload.socratic_questions) &&
        turn1Payload.socratic_questions.length > 0,
      'Turn 1 must return non-empty socratic_questions'
    );
    assert.ok(
      Array.isArray(turn1Payload.socratic_questions[0].options) &&
        turn1Payload.socratic_questions[0].options.length > 0,
      'Turn 1 socratic_questions[0] must contain selectable options'
    );

    const hasDocCitation = turn1Payload.citations.some(
      (c) => c.source_type === 'document'
    );
    const hasTableCitation = turn1Payload.citations.some(
      (c) => c.source_type === 'table'
    );
    assert.ok(hasDocCitation, 'Turn 1 citations must include document references');
    assert.ok(hasTableCitation, 'Turn 1 citations must include table references');
    console.log(
      `[Turn 1] Citations verified: ${turn1Payload.citations.length} total (document + table provenance)\n`
    );

    // -------------------------------------------------------------------------
    // TURN 2: Socratic Resolution -> STATE 2: PREVIEW_READY (Stage 1 Preview)
    // -------------------------------------------------------------------------
    const firstQuestion = turn1Payload.socratic_questions[0];
    const selectedOption = firstQuestion.options[0];
    console.log(
      `[Turn 2] Submitting Socratic resolution option "${selectedOption.option_id}" (${selectedOption.label})`
    );

    const turn2 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/resolve-socratic',
      {
        business_id: TEST_BUSINESS_ID,
        workflow_id: turn1Payload.workflow_id,
        selected_options: {
          [firstQuestion.question_id]: selectedOption.option_id,
        },
      }
    );

    assert.equal(turn2.status, 200, 'Expected HTTP 200 on Turn 2');
    const turn2Payload = turn2.data;
    console.log(`[Turn 2] Response status: ${turn2Payload.status}`);
    console.log(
      `[Turn 2] Mutations Preview Count: ${turn2Payload.mutations_preview.length}`
    );
    console.log(
      `[Turn 2] Emails Preview Count: ${turn2Payload.emails_preview.length}`
    );

    assert.equal(
      turn2Payload.status,
      'PREVIEW_READY',
      'Turn 2 must transition to PREVIEW_READY'
    );
    assert.equal(turn2Payload.workflow_id, turn1Payload.workflow_id);
    assert.ok(
      Array.isArray(turn2Payload.mutations_preview) &&
        turn2Payload.mutations_preview.length > 0,
      'Turn 2 must return non-empty mutations_preview'
    );
    assert.ok(
      Array.isArray(turn2Payload.emails_preview) &&
        turn2Payload.emails_preview.length > 0,
      'Turn 2 must return non-empty emails_preview'
    );

    for (const mutation of turn2Payload.mutations_preview) {
      assert.equal(mutation.table_name, 'orders');
      assert.ok(mutation.row_identifier, 'Each mutation must have a row_identifier');
      assert.ok(
        mutation.before && typeof mutation.before === 'object',
        'Each mutation must have a before object'
      );
      assert.ok(
        mutation.after &&
          typeof mutation.after === 'object' &&
          Object.keys(mutation.after).length > 0,
        'Each mutation must have non-empty after diffs'
      );
    }

    for (const emailDraft of turn2Payload.emails_preview) {
      assert.ok(
        emailDraft.recipient_email && emailDraft.recipient_email.includes('@'),
        'Each email preview must have a valid recipient_email'
      );
      assert.ok(emailDraft.subject, 'Each email preview must have a subject');
      assert.ok(emailDraft.body, 'Each email preview must have a personalized body');
      assert.ok(
        emailDraft.metadata && emailDraft.metadata.applied_rule,
        'Each email preview must include metadata.applied_rule'
      );
    }
    console.log(
      `[Turn 2] Sample Mutation Preview [0]: ${JSON.stringify(turn2Payload.mutations_preview[0])}`
    );
    console.log(
      `[Turn 2] Sample Email Preview [0]: to="${turn2Payload.emails_preview[0].recipient_email}", subject="${turn2Payload.emails_preview[0].subject}"\n`
    );

    // -------------------------------------------------------------------------
    // TURN 3: Stage 2 Confirmation -> STATE 3: EXECUTED
    // -------------------------------------------------------------------------
    console.log(
      `[Turn 3] Confirming operation for workflow_id="${turn1Payload.workflow_id}" (confirm: true)`
    );
    const turn3 = await jsonRequest(
      baseUrl,
      'POST',
      '/api/workspace/confirm-operation',
      {
        workflow_id: turn1Payload.workflow_id,
        business_id: TEST_BUSINESS_ID,
        confirm: true,
        dry_run: true,
      }
    );

    assert.equal(turn3.status, 200, 'Expected HTTP 200 on Turn 3');
    const turn3Payload = turn3.data;
    console.log(`[Turn 3] Response status: ${turn3Payload.status}`);
    console.log(
      `[Turn 3] Updated DB Rows Count: ${turn3Payload.updated_rows_count}`
    );
    console.log(
      `[Turn 3] Dispatched Emails Count: ${turn3Payload.dispatched_emails_count}`
    );

    assert.equal(turn3Payload.status, 'EXECUTED', 'Turn 3 must return status EXECUTED');
    assert.equal(
      turn3Payload.updated_rows_count,
      turn2Payload.mutations_preview.length,
      'All previewed row mutations must be committed in PostgreSQL'
    );
    assert.equal(
      turn3Payload.dispatched_emails_count,
      turn2Payload.emails_preview.length,
      'All previewed emails must be recorded as dispatched'
    );

    // Query the PostgreSQL `orders` table directly to verify rows were actually mutated
    const dbCheckRes = await query(
      `SELECT "Order_ID", "Dispatch_Status", "Delay_Hours", "SLA_Voucher_Issued", "Total_Amount_BDT"
       FROM "orders"
       WHERE business_id = $1
       ORDER BY "Order_ID" ASC;`,
      [TEST_BUSINESS_ID]
    );
    const rowsById = new Map(
      dbCheckRes.rows.map((r) => [String(r.Order_ID), r])
    );

    for (const mut of turn2Payload.mutations_preview) {
      const updatedRow = rowsById.get(String(mut.row_identifier));
      assert.ok(
        updatedRow,
        `Mutated row ${mut.row_identifier} must exist in PostgreSQL orders table`
      );
      for (const [col, expectedVal] of Object.entries(mut.after)) {
        const actualVal = updatedRow[col];
        if (typeof expectedVal === 'number') {
          assert.equal(
            Number(actualVal),
            expectedVal,
            `Column ${col} on ${mut.row_identifier} must equal ${expectedVal} in DB`
          );
        } else if (typeof expectedVal === 'boolean') {
          assert.equal(
            Boolean(actualVal),
            expectedVal,
            `Column ${col} on ${mut.row_identifier} must equal ${expectedVal} in DB`
          );
        } else {
          assert.equal(
            String(actualVal),
            String(expectedVal),
            `Column ${col} on ${mut.row_identifier} must equal "${expectedVal}" in DB`
          );
        }
      }
    }
    console.log(
      `[Turn 3] Direct PostgreSQL verification: all ${turn2Payload.mutations_preview.length} mutated rows in "orders" match expected post-update values!`
    );

    const recordedEmails = getDispatchedWorkspaceEmails(turn1Payload.workflow_id);
    assert.equal(
      recordedEmails.length,
      turn2Payload.emails_preview.length,
      'Recorded email dispatches must match emails_preview count'
    );
    console.log(
      `[Turn 3] Email dispatcher verification: ${recordedEmails.length} personalized customer email payloads recorded!\n`
    );

    console.log('======================================================================');
    console.log('ALL PHASE 1, PHASE 2, PHASE 3 & PHASE 4 VERIFICATION CHECKS PASSED!');
    console.log('======================================================================');
  } finally {
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

runVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
