/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const app = require('../src/app');
const { query, getPool } = require('../db');
const { clearWorkflowStoreGlobal } = require('../src/services/socraticOperationsService');
const {
  createOrRegisterDynamicTableFromCsv,
  parseAndValidateSheetCsv,
  importSheetRecordsToDatabase,
} = require('../src/services/sheetCsvImportService');

const DEMO = path.resolve(__dirname, '../demo');
const WS1 = '11111111-2222-3333-4444-555555555555';
const WS2 = '684a8863-5094-4c8b-9b15-c50c06335b7f';
const WS3 = 'd47544a4-6e80-41bb-9ddf-e694c714b4fe';
const OUT = process.env.SCENARIO_OUT || path.resolve(__dirname, 'three_new_scenarios_results.json');
const RESTORE = process.env.RESTORE_BASELINE !== 'false';

const results = { started_at: new Date().toISOString(), ingestion: {}, scenarios: {} };
const failures = [];
function check(scn, cond, msg) {
  results.scenarios[scn].checks.push({ ok: Boolean(cond), msg });
  if (!cond) failures.push(`[${scn}] ${msg}`);
  console.log(`  ${cond ? 'PASS' : 'FAIL'} - ${msg}`);
}

async function jsonReq(base, method, route, body) {
  const t0 = Date.now();
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  return { status: r.status, data, ms: Date.now() - t0 };
}

async function uploadDocs(base, biz, files) {
  const form = new FormData();
  for (const fp of files) {
    form.append('files', new Blob([fs.readFileSync(fp)], { type: 'application/pdf' }), path.basename(fp));
  }
  const r = await fetch(`${base}/api/workspace/documents/upload?business_id=${biz}&replace_all=true`, {
    method: 'POST',
    body: form,
  });
  return { status: r.status, data: await r.json() };
}

async function uploadSheet(base, biz, entity, csvPath) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(csvPath)], { type: 'text/csv' }), path.basename(csvPath));
  const r = await fetch(`${base}/api/sheets/${entity}/upload?businessId=${biz}`, { method: 'POST', body: form });
  return { status: r.status, data: await r.json() };
}

async function importViaService(biz, entity, csvPath) {
  const buf = fs.readFileSync(csvPath);
  const schema = await createOrRegisterDynamicTableFromCsv(entity, buf, biz);
  const { validRecords, totalRows } = parseAndValidateSheetCsv(buf, schema, { mode: 'replace' });
  const n = await importSheetRecordsToDatabase(biz, schema, validRecords, { mode: 'replace' });
  return { imported: n, total: totalRows, columns: Object.keys(schema.columns).length };
}

function pickOption(options, include, exclude) {
  return (
    options.find((o) => {
      const t = `${o.option_id} ${o.label} ${o.rule_interpretation}`;
      return include.test(`${o.option_id} ${o.label}`) && (!exclude || !exclude.test(`${o.option_id} ${o.label}`)) && t;
    }) || null
  );
}

function sumMap(v) {
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v;
    return Object.values(o).reduce((a, b) => a + Number(b), 0);
  } catch {
    return null;
  }
}

async function runTurns(base, scn, biz, prompt, optionMatcher) {
  const rec = results.scenarios[scn];
  rec.prompt = prompt;
  console.log(`\n=== ${scn} ===`);
  const t1 = await jsonReq(base, 'POST', '/api/workspace/execute', { business_id: biz, prompt });
  rec.turn1 = { http: t1.status, latency_ms: t1.ms, ...t1.data };
  console.log(`  Turn1 status=${t1.data.status} affected=${t1.data.affected_rows_count} conflicting=${t1.data.conflicting_rows_count} (${t1.ms}ms)`);
  console.log(`  Summary: ${t1.data.conflict_summary || t1.data.message}`);
  if (t1.data.status !== 'CLARIFICATION_REQUIRED') return null;
  const opts = t1.data.socratic_questions?.[0]?.options || [];
  const chosen = optionMatcher(opts) || opts[0];
  rec.selected_option = chosen;
  console.log(`  Options: ${opts.map((o) => `${o.option_id} [${o.label}]`).join(' | ')}`);
  console.log(`  Selected: ${chosen?.option_id}`);
  const t2 = await jsonReq(base, 'POST', '/api/workspace/resolve-socratic', {
    business_id: biz,
    workflow_id: t1.data.workflow_id,
    selected_options: chosen.option_id,
  });
  rec.turn2 = { http: t2.status, latency_ms: t2.ms, ...t2.data };
  console.log(`  Turn2 status=${t2.data.status} mutations=${t2.data.mutations_preview?.length} emails=${t2.data.emails_preview?.length} (${t2.ms}ms)`);
  if (t2.data.status !== 'PREVIEW_READY') {
    console.log(`  Turn2 error: ${JSON.stringify(t2.data).slice(0, 600)}`);
    return { t1, t2 };
  }
  for (const m of t2.data.mutations_preview) {
    console.log(`    ${m.table_name}::${m.row_identifier} ${JSON.stringify(m.before)} -> ${JSON.stringify(m.after)}`);
  }
  const t3 = await jsonReq(base, 'POST', '/api/workspace/confirm-operation', {
    business_id: biz,
    workflow_id: t1.data.workflow_id,
    confirm: true,
    dry_run: true,
  });
  rec.turn3 = { http: t3.status, latency_ms: t3.ms, ...t3.data };
  console.log(`  Turn3 status=${t3.data.status} updated=${t3.data.updated_rows_count} emails=${t3.data.dispatched_emails_count} (${t3.ms}ms)`);
  return { t1, t2, t3, opts };
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await clearWorkflowStoreGlobal();
    const bizRes = await query(`SELECT id, name FROM workspaces WHERE id = ANY($1::uuid[]);`, [[WS1, WS2, WS3]]);
    results.workspaces = bizRes.rows;
    if (bizRes.rows.length !== 3) throw new Error(`Expected 3 existing workspaces, found ${bizRes.rows.length}`);

    // ---------------- Re-ingestion ----------------
    const WORKSPACES_DIR = path.resolve(__dirname, '../../demo-workspaces');
    const s2 = fs.existsSync(path.join(DEMO, 'scenario_2'))
      ? path.join(DEMO, 'scenario_2')
      : path.join(WORKSPACES_DIR, 'Echo Demo Operations Workstation');
    const s4 = fs.existsSync(path.join(DEMO, 'scenario_4'))
      ? path.join(DEMO, 'scenario_4')
      : path.join(WORKSPACES_DIR, 'Veloura Apparel');
    const s3 = fs.existsSync(path.join(DEMO, 'scenario_3'))
      ? path.join(DEMO, 'scenario_3')
      : path.join(WORKSPACES_DIR, 'Veloura Wholesale B2B Accounts Workspace');
    const ordersCsv = fs.existsSync(path.join(DEMO, 'scenario_0', 'Commercial Orders Dataset.csv'))
      ? path.join(DEMO, 'scenario_0', 'Commercial Orders Dataset.csv')
      : path.join(s2, 'Commercial Orders Dataset.csv');
    const productsCsv = fs.existsSync(path.join(DEMO, 'scenario_1', 'products.csv'))
      ? path.join(DEMO, 'scenario_1', 'products.csv')
      : path.join(s4, 'products.csv');
    const backordersCsv = path.join(s4, 'backorders_dataset.csv');
    const wholesaleCsv = path.join(s3, 'wholesale_accunts_dataset.csv');

    const ingest = async () => {
      const r = {};
      r.ws1_docs = (await uploadDocs(base, WS1, [path.join(s2, 'QA_Batch_Recall.pdf'), path.join(s2, 'Refund_Compliance_SOP.pdf')])).data.documents;
      r.ws1_orders = await importViaService(WS1, 'orders', ordersCsv);
      r.ws2_docs = (await uploadDocs(base, WS2, [path.join(s4, 'Allocation Priority Policy.pdf'), path.join(s4, 'Port Receiving Manifest.pdf')])).data.documents;
      r.ws2_products = (await uploadSheet(base, WS2, 'products', productsCsv)).data;
      r.ws2_backorders = (await uploadSheet(base, WS2, 'backorders_dataset', backordersCsv)).data;
      r.ws3_docs = (await uploadDocs(base, WS3, [path.join(s3, 'Finance Credit Control Policy.pdf'), path.join(s3, 'Q4 VIP Expansion Brief.pdf')])).data.documents;
      r.ws3_wholesale = (await uploadSheet(base, WS3, 'wholesale_accunts_dataset', wholesaleCsv)).data;
      return r;
    };
    results.ingestion = await ingest();
    const counts = await query(
      `SELECT workspace_id, COUNT(*)::int AS docs, SUM(chunk_count)::int AS chunks FROM workspace_documents WHERE workspace_id = ANY($1::uuid[]) GROUP BY workspace_id;`,
      [[WS1, WS2, WS3]]
    );
    results.ingestion.doc_counts = counts.rows;
    const rc = async (t, b) => (await query(`SELECT COUNT(*)::int c FROM "${t}" WHERE business_id=$1`, [b])).rows[0].c;
    results.ingestion.row_counts = {
      orders: await rc('orders', WS1),
      products: await rc('products', WS2),
      backorders_dataset: await rc('backorders_dataset', WS2),
      wholesale_accunts_dataset: await rc('wholesale_accunts_dataset', WS3),
    };
    console.log('Ingestion:', JSON.stringify({ docs: counts.rows, rows: results.ingestion.row_counts }));

    // ---------------- Scenario 1 ----------------
    results.scenarios.S1 = { checks: [] };
    const p1 =
      'Find all undelivered or processing orders in orders.csv containing defective batches from the QA Batch Recall report, swap them to clean replacement batches with expedited shipping per our Refund & Replacement SOP, and email the customers their updated fulfillment details.';
    const r1 = await runTurns(base, 'S1', WS1, p1, (o) =>
      pickOption(o, /preserve|option[_\s-]*1\b|_1$/i, /strip/i)
    );
    check('S1', r1?.t1.data.status === 'CLARIFICATION_REQUIRED', 'Turn 1 CLARIFICATION_REQUIRED');
    check('S1', r1?.t1.data.affected_rows_count === 4, `affected_rows_count === 4 (got ${r1?.t1.data.affected_rows_count})`);
    check('S1', r1?.t1.data.conflicting_rows_count === 2, `conflicting_rows_count === 2 (got ${r1?.t1.data.conflicting_rows_count})`);
    check('S1', (r1?.opts || []).length >= 2, '>= 2 Socratic options');
    const c1 = r1?.t1.data.citations || [];
    check('S1', ['QA_Batch_Recall.pdf', 'Refund_Compliance_SOP.pdf'].every((f) => c1.some((c) => c.source_name === f)), 'Citations include both PDFs');
    check('S1', c1.some((c) => c.source_type === 'table' && c.source_name === 'orders'), 'Citations include orders table');
    const m1 = r1?.t2?.data.mutations_preview || [];
    const ids1 = m1.map((m) => m.row_identifier).sort();
    check('S1', JSON.stringify(ids1) === JSON.stringify(['ORD-2026-1015', 'ORD-2026-1017', 'ORD-2026-1018', 'ORD-2026-1020']), `Mutates exactly 1015/1017/1018/1020 (got ${ids1.join(',')})`);
    check('S1', m1.every((m) => m.table_name === 'orders' && m.after.Batch_Code === 'B-501' && m.after.Shipping_Tier === 'Expedited'), 'All mutations: Batch_Code=B-501, Shipping_Tier=Expedited');
    check('S1', m1.every((m) => m.after.Promo_Discount_Pct === undefined), 'Option 1 preserves Promo_Discount_Pct');
    check('S1', (r1?.t2?.data.emails_preview || []).length === 4, `4 customer emails (got ${r1?.t2?.data.emails_preview?.length})`);
    check('S1', r1?.t3?.data.status === 'EXECUTED' && r1.t3.data.updated_rows_count === 4, 'Turn 3 EXECUTED, 4 rows updated');
    const db1 = await query(
      `SELECT "Order_ID","Batch_Code","Shipping_Tier","Dispatch_Status","Refund_Status","Promo_Discount_Pct" FROM orders WHERE business_id=$1 AND "Order_ID" = ANY($2) ORDER BY "Order_ID";`,
      [WS1, ['ORD-2026-1012', 'ORD-2026-1015', 'ORD-2026-1016', 'ORD-2026-1017', 'ORD-2026-1018', 'ORD-2026-1019', 'ORD-2026-1020']]
    );
    results.scenarios.S1.db_after = db1.rows;
    const byId1 = Object.fromEntries(db1.rows.map((r) => [r.Order_ID, r]));
    check('S1', ['ORD-2026-1015', 'ORD-2026-1017', 'ORD-2026-1018', 'ORD-2026-1020'].every((i) => byId1[i]?.Batch_Code === 'B-501'), 'DB: 4 targeted rows now B-501');
    check('S1', byId1['ORD-2026-1012']?.Batch_Code === 'B-404' && byId1['ORD-2026-1016']?.Batch_Code === 'B-409' && byId1['ORD-2026-1019']?.Batch_Code === 'B-401', 'DB: Shipped/Delivered/B-401 rows untouched');

    // ---------------- Scenario 2 ----------------
    results.scenarios.S2 = { checks: [] };
    const p2 =
      'Reconcile the newly arrived inventory in the Port Receiving Manifest against open backorders in backorders_dataset.csv and update remaining available stock in products.csv according to our Allocation Priority Policy, then notify affected backorder buyers by email.';
    const r2 = await runTurns(base, 'S2', WS2, p2, (o) =>
      pickOption(o, /buffer|option[_\s-]*2\b|_2$/i, /clear(ing)?\s+(all\s+)?backorders\s+first/i)
    );
    check('S2', r2?.t1.data.status === 'CLARIFICATION_REQUIRED', 'Turn 1 CLARIFICATION_REQUIRED');
    const c2 = r2?.t1.data.citations || [];
    check('S2', ['Port Receiving Manifest.pdf', 'Allocation Priority Policy.pdf'].every((f) => c2.some((c) => c.source_name === f)), 'Citations include both PDFs');
    check('S2', ['backorders_dataset', 'products'].every((t) => c2.some((c) => c.source_type === 'table' && c.source_name === t)), 'Citations include BOTH backorders_dataset and products');
    check('S2', (r2?.opts || []).length >= 2, '>= 2 Socratic options');
    const m2 = r2?.t2?.data.mutations_preview || [];
    const prodM = m2.filter((m) => m.table_name === 'products');
    const boM = m2.filter((m) => m.table_name === 'backorders_dataset');
    check('S2', prodM.length === 1 && sumMap(prodM[0].after.size) === 10, `products: 1 row, size sum -> 10 (got ${prodM.map((m) => m.after.size).join(',')})`);
    const expBo = { 'BO-2001': [12, 'Fulfilled'], 'BO-2004': [8, 'Fulfilled'], 'BO-2002': [10, 'Fulfilled'], 'BO-2006': [10, 'Fulfilled'], 'BO-2009': [12, 'Fulfilled'], 'BO-2013': [2, 'Partial'] };
    check('S2', boM.length === 6, `backorders_dataset: 6 rows mutated (got ${boM.length})`);
    check('S2', boM.every((m) => expBo[m.row_identifier] && Number(m.after.quantity_allocated ?? m.before.quantity_allocated) === expBo[m.row_identifier][0] && String(m.after.fulfillment_status) === expBo[m.row_identifier][1]), 'Backorder allocations match Option 2 FIFO (54 units)');
    check('S2', (r2?.t2?.data.emails_preview || []).length === 6, `6 buyer emails (got ${r2?.t2?.data.emails_preview?.length})`);
    check('S2', r2?.t3?.data.status === 'EXECUTED' && r2.t3.data.updated_rows_count === 7, `Turn 3 EXECUTED, 7 rows updated across 2 tables (got ${r2?.t3?.data.updated_rows_count})`);
    const dbP = await query(`SELECT name, size FROM products WHERE business_id=$1 AND name='Classic Short-Sleeve Polo';`, [WS2]);
    const dbB = await query(`SELECT * FROM backorders_dataset WHERE business_id=$1 ORDER BY 1;`, [WS2]);
    results.scenarios.S2.db_after = { products: dbP.rows, backorders: dbB.rows.map(({ id, business_id, created_at, updated_at, ...r }) => r) };
    check('S2', sumMap(dbP.rows[0]?.size) === 10, 'DB: Classic Short-Sleeve Polo stock = 10');

    // ---------------- Scenario 3 ----------------
    results.scenarios.S3 = { checks: [] };
    const p3 =
      'Audit all wholesale accounts in wholesale_accunts_dataset.csv with overdue balances, enforce the required credit limit reductions and account holds per our Finance Credit Control Policy while factoring in Q4 VIP Expansion retention rules, and email the account contacts.';
    const r3 = await runTurns(base, 'S3', WS3, p3, (o) =>
      pickOption(o, /retention|grace|vip|option[_\s-]*2\b|_2$/i, /strict.*all|no\s+vip/i)
    );
    check('S3', r3?.t1.data.status === 'CLARIFICATION_REQUIRED', 'Turn 1 CLARIFICATION_REQUIRED');
    check('S3', r3?.t1.data.affected_rows_count === 5, `affected_rows_count === 5 (got ${r3?.t1.data.affected_rows_count})`);
    check('S3', r3?.t1.data.conflicting_rows_count === 2, `conflicting_rows_count === 2 (got ${r3?.t1.data.conflicting_rows_count})`);
    check('S3', (r3?.opts || []).length >= 2, '>= 2 Socratic options');
    const c3 = r3?.t1.data.citations || [];
    check('S3', ['Finance Credit Control Policy.pdf', 'Q4 VIP Expansion Brief.pdf'].every((f) => c3.some((c) => c.source_name === f)), 'Citations include both PDFs');
    check('S3', c3.some((c) => c.source_type === 'table' && c.source_name === 'wholesale_accunts_dataset'), 'Citations include wholesale table');
    const m3 = r3?.t2?.data.mutations_preview || [];
    const by3 = Object.fromEntries(m3.map((m) => [m.row_identifier, m]));
    const expCut = { 'ACC-1008': 2625, 'ACC-1009': 5400, 'ACC-1016': 1875 };
    check('S3', Object.entries(expCut).every(([k, v]) => Number(by3[k]?.after.credit_limit) === v && by3[k]?.after.account_status === 'Credit Hold'), 'ACC-1008/1009/1016 -> -25% and Credit Hold');
    check('S3', ['ACC-1004', 'ACC-1007'].every((k) => !by3[k] || by3[k].after.credit_limit === undefined), 'ACC-1004/1007 credit_limit preserved (VIP grace)');
    check('S3', m3.every((m) => ['ACC-1004', 'ACC-1007', 'ACC-1008', 'ACC-1009', 'ACC-1016'].includes(m.row_identifier)), 'No non-overdue accounts mutated');
    check('S3', (r3?.t2?.data.emails_preview || []).length === 5, `5 account manager emails (got ${r3?.t2?.data.emails_preview?.length})`);
    check('S3', r3?.t3?.data.status === 'EXECUTED' && r3.t3.data.updated_rows_count === m3.length, 'Turn 3 EXECUTED, all previewed rows committed');
    const db3 = await query(
      `SELECT account_id, current_tier, credit_limit, overdue_balance, account_status FROM wholesale_accunts_dataset WHERE business_id=$1 AND account_id = ANY($2) ORDER BY account_id;`,
      [WS3, ['ACC-1004', 'ACC-1007', 'ACC-1008', 'ACC-1009', 'ACC-1016', 'ACC-1001']]
    );
    results.scenarios.S3.db_after = db3.rows;
    const d3 = Object.fromEntries(db3.rows.map((r) => [r.account_id, r]));
    check('S3', Number(d3['ACC-1004']?.credit_limit) === 10000 && Number(d3['ACC-1007']?.credit_limit) === 25000, 'DB: VIP accounts limits unchanged');
    check('S3', Number(d3['ACC-1008']?.credit_limit) === 2625 && d3['ACC-1016']?.account_status === 'Credit Hold', 'DB: standard overdue accounts cut & held');

    if (RESTORE) {
      await importViaService(WS1, 'orders', ordersCsv);
      await uploadSheet(base, WS2, 'products', productsCsv);
      await uploadSheet(base, WS2, 'backorders_dataset', backordersCsv);
      await uploadSheet(base, WS3, 'wholesale_accunts_dataset', wholesaleCsv);
      results.baseline_restored = true;
      console.log('\nBaseline CSV rows restored for manual re-testing.');
    }
  } finally {
    results.failures = failures;
    results.finished_at = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    await new Promise((r) => server.close(r));
    try {
      await getPool().end();
    } catch {
      /* ignore */
    }
  }
  console.log(`\n${failures.length === 0 ? 'ALL 3 SCENARIOS PASSED' : `FAILURES (${failures.length}):\n - ${failures.join('\n - ')}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
