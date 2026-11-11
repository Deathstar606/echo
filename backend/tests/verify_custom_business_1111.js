const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const app = require('../src/app');
const { query, getPool } = require('../db');

const TEST_BIZ_ID = '11111111-2222-3333-4444-555555555555';

async function makeRequest(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const server = http.createServer(app);

    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const fetchUrl = `http://127.0.0.1:${port}${url}`;
        const headers = { 'Content-Type': 'application/json' };
        const init = { method, headers };
        if (body) {
          init.body = JSON.stringify(body);
        }

        const res = await fetch(fetchUrl, init);
        const data = await res.json().catch(() => null);
        server.close();
        resolve({ status: res.status, data });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

async function runTest() {
  console.log(`\n======================================================`);
  console.log(`VERIFYING BUSINESS ID: ${TEST_BIZ_ID}`);
  console.log(`======================================================\n`);

  // 1. Verify business lookup endpoint
  console.log('[Step 1] Calling GET /api/businesses/' + TEST_BIZ_ID);
  const bizLookup = await makeRequest('GET', `/api/businesses/${TEST_BIZ_ID}`);
  console.log('  -> Status:', bizLookup.status, bizLookup.data);
  assert.equal(bizLookup.status, 200);
  assert.equal(bizLookup.data.id, TEST_BIZ_ID);
  console.log('  ✓ Business lookup succeeded!');

  // 2. Seed demo workspace for this business
  console.log('\n[Step 2] Seeding demo assets via POST /api/workspace/demo/seed...');
  const seedRes = await makeRequest('POST', '/api/workspace/demo/seed', {
    business_id: TEST_BIZ_ID,
  });
  console.log('  -> Status:', seedRes.status, seedRes.data?.message);
  assert.ok(seedRes.status === 200 || seedRes.status === 201);
  console.log('  ✓ Demo seeded for business:', TEST_BIZ_ID);

  // 3. Verify documents list
  console.log('\n[Step 3] Fetching documents via GET /api/workspace/documents...');
  const docsRes = await makeRequest('GET', `/api/workspace/documents?business_id=${TEST_BIZ_ID}`);
  console.log('  -> Status:', docsRes.status, 'Total docs:', docsRes.data?.documents?.length);
  assert.equal(docsRes.status, 200);
  assert.ok(docsRes.data?.documents?.length >= 2);
  console.log('  ✓ Unstructured documents verified!');

  // 4. Execute complex B2B task
  const instruction =
    'Check which orders in our spreadsheet are affected by this shipment delay, update their status, and notify those customers per our SLA policy.';
  console.log('\n[Step 4] Executing complex B2B operations prompt:');
  console.log(`  "${instruction}"`);

  const execRes = await makeRequest('POST', '/api/workspace/execute', {
    business_id: TEST_BIZ_ID,
    prompt: instruction,
    entity: 'orders',
  });

  console.log('  -> Turn 1 Status:', execRes.data?.status);
  assert.equal(execRes.data?.status, 'CLARIFICATION_REQUIRED');
  assert.ok(execRes.data?.workflow_id, 'Workflow ID must be generated');
  console.log('  -> Workflow ID:', execRes.data.workflow_id);
  console.log('  -> Conflict Summary:', execRes.data.conflict_summary?.slice(0, 120) + '...');
  console.log('  -> Affected Rows:', execRes.data.affected_rows_count);
  console.log('  -> Conflicting Rows:', execRes.data.conflicting_rows_count);
  console.log('  -> Socratic Questions:', execRes.data.socratic_questions?.length);
  console.log('  -> Citations:', execRes.data.citations?.length);
  console.log('  ✓ Turn 1 (Conflict Gate) PASSED!');

  // 5. Resolve Socratic Conflict
  const workflowId = execRes.data.workflow_id;
  console.log('\n[Step 5] Resolving conflict via POST /api/workspace/resolve-socratic...');
  const resolveRes = await makeRequest('POST', '/api/workspace/resolve-socratic', {
    business_id: TEST_BIZ_ID,
    workflow_id: workflowId,
    selected_options: 'cap_existing_and_update_all_impacted',
  });

  console.log('  -> Turn 2 Status:', resolveRes.data?.status);
  assert.equal(resolveRes.data?.status, 'PREVIEW_READY');
  assert.ok(resolveRes.data?.mutations_preview?.length > 0);
  assert.ok(resolveRes.data?.emails_preview?.length > 0);
  console.log('  -> Mutations preview count:', resolveRes.data.mutations_preview.length);
  console.log('  -> Emails preview count:', resolveRes.data.emails_preview.length);
  console.log('  ✓ Turn 2 (Preview Ready) PASSED!');

  // 6. Confirm and apply
  console.log('\n[Step 6] Confirming execution via POST /api/workspace/confirm-operation...');
  const confirmRes = await makeRequest('POST', '/api/workspace/confirm-operation', {
    business_id: TEST_BIZ_ID,
    workflow_id: workflowId,
    confirm: true,
  });

  console.log('  -> Turn 3 Status:', confirmRes.data?.status);
  assert.equal(confirmRes.data?.status, 'EXECUTED');
  console.log('  -> Updated Rows in DB:', confirmRes.data.updated_rows_count);
  console.log('  -> Dispatched Emails:', confirmRes.data.dispatched_emails_count);
  assert.equal(confirmRes.data.updated_rows_count, resolveRes.data.mutations_preview.length);
  assert.equal(confirmRes.data.dispatched_emails_count, resolveRes.data.emails_preview.length);
  console.log('  ✓ Turn 3 (Executed & Dispatched) PASSED!');

  console.log(`\n======================================================`);
  console.log(`ALL VERIFICATION CHECKS PASSED FOR ${TEST_BIZ_ID}!`);
  console.log(`======================================================\n`);

  const pool = getPool();
  await pool.end();
}

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
