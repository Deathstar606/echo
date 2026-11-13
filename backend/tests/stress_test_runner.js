/* eslint-disable no-console */
process.env.SMTP_TEST_MODE = 'true';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const app = require('../src/app');
const { query, getPool } = require('../db');
const { clearWorkflowStoreGlobal } = require('../src/services/socraticOperationsService');

const WORKSPACES = [
  {
    key: 'WS1',
    id: '11111111-2222-3333-4444-555555555555',
    name: 'Echo Demo Operations Workspace',
    prompt:
      'Find all undelivered or processing orders in orders.csv containing defective batches from the QA Batch Recall report, swap them to clean replacement batches with expedited shipping per our Refund & Replacement SOP, and email the customers their updated fulfillment details.',
    desired_action:
      'Identify processing/undelivered orders linked to defective batch B-409, trigger a Socratic governance conflict under SOP-REV-802 Section 4 (due to promo discounts or high-value orders requiring resolution), resolve via operator option to replace with clean batch B-501 and upgrade to Expedited shipping, preview row mutations and customer notification emails, atomically update the orders table upon confirmation, and dispatch customer emails via test SMTP.',
    option_preference: /preserve|option_1|replace/i,
    tables_to_restore: ['orders'],
  },
  {
    key: 'WS2',
    id: '684a8863-5094-4c8b-9b15-c50c06335b7f',
    name: 'Veloura Apparel',
    prompt:
      'Reconcile the newly arrived inventory in the Port Receiving Manifest against open backorders in backorders_dataset.csv and update remaining available stock in products.csv according to our Allocation Priority Policy, then notify affected backorder buyers by email.',
    desired_action:
      'Reconcile 64 units of Classic Short-Sleeve Polo (VL-POLO-BLK) from Port Receiving Manifest against 60 open backorder units and the 10-unit storefront buffer in products.csv, trigger a Socratic conflict for the 6-unit buffer deficit under SOP-OPS-019 Section 4.2, resolve via operator option (e.g. prioritize storefront buffer or clear backorders), generate multi-table mutation preview updating both backorders_dataset and products, generate buyer notification emails, atomically commit upon confirmation, and dispatch emails.',
    option_preference: /option_2|enforce|buffer|option_1|prioritize/i,
    tables_to_restore: ['backorders_dataset', 'products'],
  },
  {
    key: 'WS3',
    id: 'd47544a4-6e80-41bb-9ddf-e694c714b4fe',
    name: 'Veloura Wholesale B2B Accounts Workspace',
    prompt:
      'Review all overdue accounts in wholesale_accunts_dataset.csv, enforce the mandatory credit limit reductions and credit holds per our Finance Credit Control Policy while honoring Q4 VIP partner retention exemptions from the Q4 VIP Expansion Brief, and notify account managers by email.',
    desired_action:
      'Identify overdue wholesale accounts (ACC-1004, ACC-1007, ACC-1008, ACC-1009, ACC-1016), detect the policy conflict between strict 25% credit limit cuts and Credit Hold under FIN-POL-008 vs Q4 VIP 14-day retention grace for high-spend/Gold accounts under DIR-COM-2026-Q4, enter CLARIFICATION_REQUIRED, resolve via operator option (Option 2 VIP grace exemption), preview credit limit adjustments and account status updates alongside account manager emails, atomically commit changes on confirmation, and dispatch emails.',
    option_preference: /option_2|grace|retention|vip/i,
    tables_to_restore: ['wholesale_accunts_dataset'],
  },
  {
    key: 'WS4',
    id: '52e50e84-197e-41f0-ba30-4bdeeabafa5e',
    name: 'Hospital Management Demo Workspace',
    prompt:
      'Evaluate all ICU units in hospital_units.csv for Surge Ready classification and float pool allocation under our Hospital Bed Allocation Policy and Clinical Staffing Protocol, resolve any staffing gap conflicts against the nursing float roster, and notify the charge nurses by email.',
    desired_action:
      'Evaluate ICU units against bed criteria (staffed_beds - occupied_beds >= 2 and clean_beds >= 2) and staffing gaps, detect the clinical staffing conflict under Section 5 where HICU-01 meets bed thresholds but has staffing_gap = 2, enter CLARIFICATION_REQUIRED with float pool deployment options (CCRN float RN-301 assignment vs holding at Staffing Constrained and promoting zero-gap HICU-04), exclude NICU/PICU specialty units, preview surge_status mutations and charge nurse notification emails, atomically commit upon confirmation, and dispatch emails.',
    option_preference: /option_1|deploy|float|ready|option_2|constrained/i,
    tables_to_restore: ['hospital_units'],
  },
];

async function apiCallWithRetry(url, options, maxRetries = 3) {
  let lastResponse = null;
  let lastData = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, options);
      const data = await res.json();
      lastResponse = res;
      lastData = data;
      const ms = Date.now() - t0;
      if (res.status === 200 || res.status === 201) {
        return { status: res.status, data, ms };
      }
      if ((res.status === 502 || res.status === 503) && attempt < maxRetries) {
        console.warn(`[API Retry ${attempt}/${maxRetries}] HTTP ${res.status} from ${url}. Waiting before retry...`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      return { status: res.status, data, ms };
    } catch (err) {
      console.warn(`[Network Retry ${attempt}/${maxRetries}] Error: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw err;
    }
  }
  return { status: lastResponse?.status || 500, data: lastData, ms: 0 };
}

async function backupTable(tableName, workspaceId) {
  const res = await query(
    `SELECT * FROM "${tableName}" WHERE (business_id = $1 OR workspace_id = $1)`,
    [workspaceId]
  );
  return res.rows;
}

async function restoreTable(tableName, workspaceId, originalRows) {
  if (!originalRows || originalRows.length === 0) return;
  await query(
    `DELETE FROM "${tableName}" WHERE (business_id = $1 OR workspace_id = $1)`,
    [workspaceId]
  );
  for (const row of originalRows) {
    const keys = Object.keys(row).filter((k) => k !== 'total_stock' && !k.startsWith('_'));
    const cols = keys.map((k) => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map((k) => {
      const v = row[k];
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        return JSON.stringify(v);
      }
      return v;
    });
    await query(
      `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders})`,
      values
    );
  }
}

async function runStressTest() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  console.log(`Stress test server listening on ${base}`);

  const testReport = {
    started_at: new Date().toISOString(),
    smtp_test_mode: process.env.SMTP_TEST_MODE,
    results: [],
  };

  try {
    for (const ws of WORKSPACES) {
      console.log(`\n============================================================`);
      console.log(`RUNNING STRESS TEST: ${ws.name} (${ws.id})`);
      console.log(`Prompt: "${ws.prompt}"`);
      console.log(`============================================================`);

      await clearWorkflowStoreGlobal();

      // Backup tables before test
      const backups = {};
      for (const t of ws.tables_to_restore) {
        backups[t] = await backupTable(t, ws.id);
        console.log(`Backed up ${backups[t].length} rows for table "${t}"`);
      }

      const wsResult = {
        workspace_id: ws.id,
        workspace_name: ws.name,
        prompt: ws.prompt,
        desired_action: ws.desired_action,
        turns: {},
        actions_performed: [],
        inconsistencies_or_failures: [],
        success: false,
      };

      try {
        // TURN 1: Execute Cross-Document Operation
        console.log(`\n--- Turn 1: POST /api/workspace/execute ---`);
        const t1 = await apiCallWithRetry(`${base}/api/workspace/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: ws.id,
            prompt: ws.prompt,
            entity: 'user',
          }),
        });

        wsResult.turns.turn1 = {
          status: t1.status,
          ms: t1.ms,
          data: t1.data,
        };

        console.log(`Turn 1 Response: HTTP ${t1.status} (${t1.ms}ms)`);
        console.log(`Status: ${t1.data?.status}`);
        console.log(`Workflow ID: ${t1.data?.workflow_id}`);
        console.log(`Conflict Summary: ${t1.data?.conflict_summary || t1.data?.message || 'N/A'}`);
        console.log(`Affected Count: ${t1.data?.affected_rows_count}`);
        console.log(`Conflicting Count: ${t1.data?.conflicting_rows_count}`);
        console.log(`Citations Count: ${t1.data?.citations?.length || 0}`);

        if (t1.status !== 200) {
          wsResult.inconsistencies_or_failures.push(`Turn 1 failed with HTTP ${t1.status}: ${JSON.stringify(t1.data)}`);
          wsResult.actions_performed.push(`Turn 1 failed with HTTP ${t1.status}`);
          continue;
        }

        const workflowId = t1.data?.workflow_id;
        const status = t1.data?.status;

        if (status === 'CLARIFICATION_REQUIRED') {
          wsResult.actions_performed.push(
            `Turn 1 identified ${t1.data.affected_rows_count} affected records and ${t1.data.conflicting_rows_count} policy conflicts, successfully entering CLARIFICATION_REQUIRED state with ${t1.data.socratic_questions?.length || 0} Socratic questions citing ${t1.data.citations?.length || 0} sources.`
          );

          // Select Socratic Option
          const questions = t1.data.socratic_questions || [];
          const selectedOptionsMap = {};

          for (const q of questions) {
            const options = q.options || [];
            let chosen = options.find((o) => ws.option_preference.test(o.option_id + ' ' + o.label));
            if (!chosen && options.length > 0) {
              chosen = options[0];
            }
            if (chosen) {
              selectedOptionsMap[q.question_id] = chosen.option_id;
              console.log(`Selected option for "${q.question_id}": [${chosen.option_id}] ${chosen.label}`);
            }
          }

          // TURN 2: Resolve Socratic Conflict
          console.log(`\n--- Turn 2: POST /api/workspace/resolve-socratic ---`);
          const t2 = await apiCallWithRetry(`${base}/api/workspace/resolve-socratic`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              business_id: ws.id,
              workflow_id: workflowId,
              selected_options: selectedOptionsMap,
            }),
          });

          wsResult.turns.turn2 = {
            status: t2.status,
            ms: t2.ms,
            data: t2.data,
          };

          console.log(`Turn 2 Response: HTTP ${t2.status} (${t2.ms}ms)`);
          console.log(`Status: ${t2.data?.status}`);
          console.log(`Mutations Preview Count: ${t2.data?.mutations_preview?.length || 0}`);
          console.log(`Emails Preview Count: ${t2.data?.emails_preview?.length || 0}`);

          if (t2.status !== 200 || t2.data?.status !== 'PREVIEW_READY') {
            wsResult.inconsistencies_or_failures.push(
              `Turn 2 failed to compile preview: HTTP ${t2.status}, status=${t2.data?.status}: ${JSON.stringify(t2.data)}`
            );
            wsResult.actions_performed.push(`Turn 2 failed with HTTP ${t2.status}`);
            continue;
          }

          wsResult.actions_performed.push(
            `Turn 2 resolved Socratic options and transitioned to PREVIEW_READY: generated ${t2.data.mutations_preview?.length || 0} row mutation previews and ${t2.data.emails_preview?.length || 0} notification email previews.`
          );

          // TURN 3: Confirm & Execute Operation
          console.log(`\n--- Turn 3: POST /api/workspace/confirm-operation ---`);
          const t3 = await apiCallWithRetry(`${base}/api/workspace/confirm-operation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              business_id: ws.id,
              workflow_id: workflowId,
              confirm: true,
              dryRun: false,
            }),
          });

          wsResult.turns.turn3 = {
            status: t3.status,
            ms: t3.ms,
            data: t3.data,
          };

          console.log(`Turn 3 Response: HTTP ${t3.status} (${t3.ms}ms)`);
          console.log(`Status: ${t3.data?.status}`);
          console.log(`Updated Rows Count: ${t3.data?.updated_rows_count}`);
          console.log(`Dispatched Emails Count: ${t3.data?.dispatched_emails_count}`);

          if (t3.status === 200 && t3.data?.status === 'EXECUTED') {
            wsResult.actions_performed.push(
              `Turn 3 confirmed execution: atomically updated ${t3.data.updated_rows_count} database rows across target tables and dispatched ${t3.data.dispatched_emails_count} demo notification emails via Nodemailer test transport.`
            );
            wsResult.success = true;
          } else {
            wsResult.inconsistencies_or_failures.push(
              `Turn 3 failed to execute: HTTP ${t3.status}, status=${t3.data?.status}: ${JSON.stringify(t3.data)}`
            );
            wsResult.actions_performed.push(`Turn 3 confirmation failed with HTTP ${t3.status}`);
          }
        } else if (status === 'PREVIEW_READY') {
          wsResult.actions_performed.push(
            `Turn 1 directly transitioned to PREVIEW_READY (zero policy conflicts required operator clarification): generated ${t1.data.mutations_preview?.length || 0} mutations and ${t1.data.emails_preview?.length || 0} email previews.`
          );

          // Direct Confirm
          console.log(`\n--- Turn 2 (Direct Confirm): POST /api/workspace/confirm-operation ---`);
          const t3 = await apiCallWithRetry(`${base}/api/workspace/confirm-operation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              business_id: ws.id,
              workflow_id: workflowId,
              confirm: true,
              dryRun: false,
            }),
          });

          wsResult.turns.turn3 = {
            status: t3.status,
            ms: t3.ms,
            data: t3.data,
          };

          if (t3.status === 200 && t3.data?.status === 'EXECUTED') {
            wsResult.actions_performed.push(
              `Confirmed execution: atomically updated ${t3.data.updated_rows_count} database rows and dispatched ${t3.data.dispatched_emails_count} demo notification emails.`
            );
            wsResult.success = true;
          } else {
            wsResult.inconsistencies_or_failures.push(
              `Direct confirmation failed: HTTP ${t3.status}, status=${t3.data?.status}: ${JSON.stringify(t3.data)}`
            );
          }
        } else {
          wsResult.inconsistencies_or_failures.push(
            `Unexpected Turn 1 status "${status}" (expected CLARIFICATION_REQUIRED or PREVIEW_READY): ${t1.data?.message || ''}`
          );
          wsResult.actions_performed.push(`Turn 1 returned status "${status}"`);
        }
      } catch (err) {
        console.error(`Error during stress test for ${ws.name}:`, err);
        wsResult.inconsistencies_or_failures.push(`Unhandled exception: ${err.message}`);
      } finally {
        // Restore tables to ensure no permanent mutation leaks
        console.log(`\nRestoring original baseline rows for workspace ${ws.name}...`);
        for (const t of ws.tables_to_restore) {
          if (backups[t]) {
            await restoreTable(t, ws.id, backups[t]);
            console.log(`Restored ${backups[t].length} rows for table "${t}"`);
          }
        }
      }

      testReport.results.push(wsResult);
    }

    testReport.finished_at = new Date().toISOString();
    const outJsonPath = path.resolve(__dirname, 'stress_test_run_telemetry.json');
    fs.writeFileSync(outJsonPath, JSON.stringify(testReport, null, 2), 'utf8');
    console.log(`\nSaved full stress test telemetry to ${outJsonPath}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const pool = getPool();
    if (pool) await pool.end();
  }
}

runStressTest().catch((err) => {
  console.error('Fatal stress test runner error:', err);
  process.exit(1);
});
