/* eslint-disable no-console */
process.env.SMTP_TEST_MODE = 'true';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const app = require('../src/app');
const { query, getPool } = require('../db');

const OWNER_USER_ID = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_USER_ID = 'cd9d3fcf-e923-4996-9cf4-c0d5bc403480';

const WORKSPACES = {
  WS1: {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'Echo Demo Operations Workspace',
  },
  WS2: {
    id: '684a8863-5094-4c8b-9b15-c50c06335b7f',
    name: 'Veloura Apparel',
  },
  WS3: {
    id: 'd47544a4-6e80-41bb-9ddf-e694c714b4fe',
    name: 'Veloura Wholesale B2B Accounts Workspace',
  },
  WS4: {
    id: '52e50e84-197e-41f0-ba30-4bdeeabafa5e',
    name: 'Hospital Management Demo Workspace',
  },
};

const TEST_CASES = [
  // ================= Workspace 1: Echo Demo Operations Workspace =================
  {
    id: 'WS1-CASE-1',
    wsKey: 'WS1',
    title: 'Executive Leather Recliner 78-Hour Delay & Promo Stack Policy',
    customer_text:
      "Hi, I'm checking on order ORD-2026-1026 for the Executive Leather Recliner. It's been delayed for over 3 days now. Since I already had a 10% promotional discount applied, am I eligible for the 100% white-glove freight rebate and delay voucher, or does the promo prevent that?",
  },
  {
    id: 'WS1-CASE-2',
    wsKey: 'WS1',
    title: 'KVM Switch Batch Recall, Dhaka Express Transfer & bKash Cap',
    customer_text:
      "Hello, my order ORD-2026-1022 for two Echo Pro KVM switches still says Processing in Chittagong. I heard there's a hardware recall on older batches. If I want to cancel for a full 18,400 BDT refund to my bKash instead of waiting for replacement units from Dhaka, how does that work?",
  },
  {
    id: 'WS1-CASE-3',
    wsKey: 'WS1',
    title: 'Perishable Praline Tart 28-Hour Delay Freshness Cutoff',
    customer_text:
      'Hi, I ordered a Hazelnut Praline Tart (ORD-2026-1028) that is now 28 hours late. Since this is perishable bakery food, do I have to wait 48 hours for an SLA voucher like your electronics orders, or can I get an immediate re-bake or refund?',
  },

  // ================= Workspace 2: Veloura Apparel =================
  {
    id: 'WS2-CASE-1',
    wsKey: 'WS2',
    title: 'Polo Backorder Allocation & 5% Unfulfilled Balance Credit',
    customer_text:
      'Hi, Daniel from Pacific Rim Clothiers here regarding our backorder BO-2013 for 8 units of the Classic Short-Sleeve Polo. If our order only gets a partial allocation of 2 units due to your 10-unit storefront buffer reserve, will we receive a 5% credit on the remaining 6 unfulfilled units?',
  },
  {
    id: 'WS2-CASE-2',
    wsKey: 'WS2',
    title: 'Pima Cotton Henley Customs Hold Free-Time Demurrage Deadline',
    customer_text:
      'Hello, we are inquiring about backorder BO-2019 for the Pima Cotton Henley. Since the manifest shows container PRM-2026-1104-CTG has a customs hold, what is the port free-time demurrage deadline, and can we cancel penalty-free if clearance exceeds 10 calendar days?',
  },
  {
    id: 'WS2-CASE-3',
    wsKey: 'WS2',
    title: 'Structured Linen Blazer Boutique Order & 35% Margin Restriction',
    customer_text:
      'Good day, our boutique wants to purchase 10 units of the Structured Linen Blazer from your online catalog in sizes M and L. Can we negotiate an additional 15% wholesale discount off your listed sale price of 4,490 BDT, or is there a minimum gross margin restriction?',
  },

  // ================= Workspace 3: Veloura Wholesale B2B Accounts Workspace =================
  {
    id: 'WS3-CASE-1',
    wsKey: 'WS3',
    title: 'Vanguard Garment Overdue Balance, SWIFT Wire Grace & Credit Hold',
    customer_text:
      'Hi, David Chen from Vanguard Garment Distributors (ACC-1004). Our annual spend reached $16,200 which qualifies for Gold tier under your Q4 VIP Expansion Brief, but we have an overdue balance of $1,850. If we submit proof of wire transfer SWIFT-HK-90412 today, can we avoid the mandatory 25% credit limit reduction and Credit Hold?',
  },
  {
    id: 'WS3-CASE-2',
    wsKey: 'WS3',
    title: 'Crestview Short-Shipment Dispute on INV-2026-8804 & Credit Protection',
    customer_text:
      'Hello, this is Priya Nair from Crestview Department Stores (ACC-1009). We received a notification regarding an overdue balance of $920 on invoice INV-2026-8804. We filed a formal Short-Shipment Dispute on that invoice—does the disputed status protect our $7,200 credit limit from being slashed by 25% while under audit?',
  },
  {
    id: 'WS3-CASE-3',
    wsKey: 'WS3',
    title: 'Kensington Bespoke Platinum Fast-Track Terms & Benefits',
    customer_text:
      'Hello, Arthur Pendelton here from Kensington Bespoke Clothiers (ACC-1017). Our annual spend is currently $42,500 at Gold tier with zero overdue balance. What are the qualification requirements and credit line benefits if we fast-track to Platinum under the Q4 VIP Brief?',
  },

  // ================= Workspace 4: Hospital Management Demo Workspace =================
  {
    id: 'WS4-CASE-1',
    wsKey: 'WS4',
    title: 'Critical Respiratory Patients & Adult ICU North Staffing Gap',
    customer_text:
      'Bed Control, Emergency Department charge nurse here. We have 3 critical adult respiratory patients waiting in ED. Can Adult ICU North (HICU-01) accept them right now, or are they blocked by staffing gaps and clean bed turnaround rules?',
  },
  {
    id: 'WS4-CASE-2',
    wsKey: 'WS4',
    title: 'Cardiac Step-Down PCU Overtime Cap for Float Nurse RN-306',
    customer_text:
      'Nursing Supervisor inquiry: Our Cardiac Step-Down PCU (HPCU-01) is experiencing an acute surge with a staffing gap. Can we authorize float nurse Claire Dubois (RN-306) to work a 12-hour overtime shift on PCU to cover the gap?',
  },
  {
    id: 'WS4-CASE-3',
    wsKey: 'WS4',
    title: 'Infectious Isolation 45-Min HEPA Purge & ICU Ambulance Bypass Trigger',
    customer_text:
      'EVS and Clinical Command: A patient in Infectious Disease Isolation (HWARD-02) was just discharged. What is the mandatory HEPA air purge duration before EVS can mark the bed clean, and if our total Adult ICU clean beds drop below 5 while ED Observation is at 100%, does that trigger an immediate Ambulance Bypass?',
  },
];

function httpJson(baseUrl, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== null ? JSON.stringify(body) : null;
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload !== null
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCustomerResponseTest() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Customer response test server listening on ${baseUrl}`);

  const testReport = {
    started_at: new Date().toISOString(),
    owner_user_id: OWNER_USER_ID,
    test_cases_total: TEST_CASES.length,
    results: [],
  };

  const createdConversationIds = [];

  try {
    for (const tc of TEST_CASES) {
      const ws = WORKSPACES[tc.wsKey];
      console.log(`\n============================================================`);
      console.log(`TEST CASE: [${tc.id}] ${tc.title}`);
      console.log(`Workspace: ${ws.name} (${ws.id})`);
      console.log(`Customer text: "${tc.customer_text}"`);
      console.log(`============================================================`);

      // 1. Create Conversation
      const convRes = await httpJson(
        baseUrl,
        'POST',
        `/api/businesses/${ws.id}/conversations`,
        { customerId: CUSTOMER_USER_ID },
        { 'x-user-id': OWNER_USER_ID }
      );

      if (convRes.status !== 201 || !convRes.data?.id) {
        console.error(`Failed creating conversation: HTTP ${convRes.status}`, convRes.data);
        testReport.results.push({
          case_id: tc.id,
          workspace_name: ws.name,
          workspace_id: ws.id,
          customer_text: tc.customer_text,
          error: `Failed to create conversation: HTTP ${convRes.status}`,
          success: false,
        });
        continue;
      }

      const convId = convRes.data.id;
      createdConversationIds.push(convId);

      // 2. Post Customer Message
      const msgRes = await httpJson(
        baseUrl,
        'POST',
        `/api/businesses/${ws.id}/conversations/${convId}/messages`,
        { sender_type: 'customer', message: tc.customer_text },
        { 'x-user-id': OWNER_USER_ID }
      );

      if (msgRes.status !== 201) {
        console.error(`Failed posting message: HTTP ${msgRes.status}`, msgRes.data);
        testReport.results.push({
          case_id: tc.id,
          workspace_name: ws.name,
          workspace_id: ws.id,
          customer_text: tc.customer_text,
          error: `Failed to post customer message: HTTP ${msgRes.status}`,
          success: false,
        });
        continue;
      }

      // 3. Generate Reply Draft (with up to 3 retries for transient 502/503)
      let draftRes = null;
      let elapsedMs = 0;
      let retriesCount = 0;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const t0 = Date.now();
        draftRes = await httpJson(
          baseUrl,
          'POST',
          `/api/businesses/${ws.id}/conversations/${convId}/reply-draft`,
          {},
          { 'x-user-id': OWNER_USER_ID }
        );
        elapsedMs = Date.now() - t0;

        if (draftRes.status === 200) {
          break;
        }

        if ((draftRes.status === 502 || draftRes.status === 503) && attempt < 3) {
          retriesCount += 1;
          console.warn(`[Draft Retry ${attempt}/3] HTTP ${draftRes.status}. Retrying in ${attempt * 3000}ms...`);
          await sleep(attempt * 3000);
          continue;
        }
        break;
      }

      const returnedResponse = draftRes.data?.ai_draft_reply || '';
      const suggestion = draftRes.data?.ai_suggestion || {};

      console.log(`\nGenerated Response (HTTP ${draftRes.status}, ${elapsedMs}ms, retries: ${retriesCount}):`);
      console.log(`Category: ${suggestion.category || 'N/A'}`);
      console.log(`Missing Info: ${JSON.stringify(suggestion.missing_information || [])}`);
      console.log(`AI Draft Reply:\n"${returnedResponse}"`);

      testReport.results.push({
        case_id: tc.id,
        title: tc.title,
        workspace_name: ws.name,
        workspace_id: ws.id,
        customer_text: tc.customer_text,
        http_status: draftRes.status,
        elapsed_ms: elapsedMs,
        retries_count: retriesCount,
        category: suggestion.category || null,
        missing_information: suggestion.missing_information || [],
        returned_response: returnedResponse,
        success: draftRes.status === 200 && Boolean(returnedResponse),
      });

      // Brief delay between calls to prevent rate limits
      await sleep(1500);
    }

    testReport.finished_at = new Date().toISOString();
    const outJsonPath = path.resolve(__dirname, 'customer_response_test_telemetry.json');
    fs.writeFileSync(outJsonPath, JSON.stringify(testReport, null, 2), 'utf8');
    console.log(`\nSaved customer response test telemetry to ${outJsonPath}`);
  } finally {
    // Cleanup created test conversations
    console.log(`\nCleaning up ${createdConversationIds.length} test conversations...`);
    for (const cId of createdConversationIds) {
      await query('DELETE FROM messages WHERE conversation_id = $1;', [cId]);
      await query('DELETE FROM conversations WHERE id = $1;', [cId]);
    }
    console.log(`Cleanup completed.`);

    await new Promise((resolve) => server.close(resolve));
    const pool = getPool();
    if (pool) await pool.end();
  }
}

runCustomerResponseTest().catch((err) => {
  console.error('Fatal customer response test runner error:', err);
  process.exit(1);
});
