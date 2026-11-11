# Customer Reply Generation Test Report

## Outcome

Customer messages are no longer sent through automatic AI reply generation. A company agent can explicitly generate or regenerate an editable reply draft from the active workspace, the latest customer message, and up to five preceding messages. Draft generation does not send an email or add an agent message.

The generation request is scoped to the selected workspace after ownership validation. Document retrieval and spreadsheet-row retrieval receive that workspace ID; a synthetic second workspace was used to verify its private content was not present in the prompt.

## Implementation summary

- Added an explicit reply-draft API action and company inbox control.
- Removed Gemini generation from the message-posting flow.
- Limited context to relevant document excerpts and spreadsheet rows from the active workspace.
- Added prompt safeguards to distinguish known facts from unverified eligibility conditions, request missing facts, and avoid promises unsupported by workspace records.
- Saved drafts transactionally and verified the source customer message was still the latest message before persisting, preventing stale drafts from being attached to a newer conversation state.
- Cleared active drafts when a new message arrives. Migration `backend/db/migrations/011_clear_legacy_ai_reply_drafts.sql` clears legacy AI draft/suggestion metadata without deleting messages or conversations.

## Live Gemini checks

All four checks used synthetic apparel data and synthetic policy text with `gemini-3.5-flash-lite`. They used the workspace retrieval path and a mock sheet data pool; no real customer data was used and no email was sent. Prompt token counts are the counts logged by Gemini for these individual requests.

### 1. Spreadsheet inventory

**Customer message:** “Do you have the TrailFlex Jacket in stock, and what does it cost?”

**Retrieved context:** Active-workspace inventory row for TrailFlex Jacket, size M, stock quantity 4, price $79.99. The retrieval also returned a returns policy document, which did not affect the answer.

**Generated draft:** “Yes, the TrailFlex Jacket in size M is currently in stock and priced at $79.99.”

**Missing information:** None.

**Prompt tokens:** 572.

### 2. Policy-document question

**Customer message:** “I received the wrong size. Can I exchange it, and how long will that take?”

**Retrieved context:** Active-workspace policy says exchanges are accepted within 30 days for unworn items with tags attached, and take 3 to 5 business days after the returned item is received.

**Generated draft:** “Yes, we accept exchanges within 30 days for unworn items with tags attached, and exchange processing takes 3 to 5 business days after we receive the returned item. Could you please confirm when you purchased the item and its current condition?”

**Missing information:** Purchase date; item condition and whether tags are attached.

**Prompt tokens:** 574.

### 3. Recursive follow-up with conversation history

**Previous messages, oldest first:**

1. Customer: “I ordered the TrailFlex Jacket but received the wrong size.”
2. Agent: “I can help check the exchange options.”
3. Customer: “I would like to exchange it.”

**Latest customer message:** “Would medium be available instead?”

**Retrieved context:** Active-workspace inventory row shows size M in stock; the active-workspace exchange policy contains the eligibility requirements above.

**Generated draft:** “Yes, we currently have the TrailFlex Jacket in size M available in our inventory. To proceed with your exchange, could you please confirm when you originally purchased the item and whether it is unworn with the tags attached?”

**Missing information:** Original purchase date; item condition and whether tags are attached.

**Prompt tokens:** 611.

### 4. Unsupported shipping detail

**Customer message:** “Can you guarantee overnight delivery?”

**Retrieved context:** No active-workspace shipping or overnight-delivery facts were retrieved. The returns policy was retrieved but did not answer the question.

**Generated draft:** “I'm sorry, but I don't have information regarding overnight delivery options in our current policy details.”

**Missing information:** Delivery location; shipping carrier options.

**Prompt tokens:** 501.

### Workspace-isolation check

A second synthetic workspace contained the marker `OTHER_WORKSPACE_SECRET` and a claim about free overnight delivery. Neither the marker nor that workspace's document appeared in the generated prompt or retrieved-document list for any check.

## Additional four live tests on existing workspaces

These are four additional read-only live Gemini checks, run after the synthetic checks above. Each used the actual PostgreSQL-backed retrieval path for the named workspace:

`retrieveCrossDocumentContext(workspace ID, message) -> buildWorkspaceSupportPrompt -> generateAiSupportResponse`

I checked each response against the exact workspace-scoped PostgreSQL row after generation. No conversation messages or drafts were saved, no spreadsheet data was changed, and no email was sent. The workspace IDs below disambiguate the exact workspaces selected.

### Test 1 — Echo Demo Operations Workspace

**Workspace ID:** `11111111-2222-3333-4444-555555555555`

**Customer message:** “I am asking about order ORD-2026-1003. How many hours was it delayed, was an SLA voucher already issued, and what does the workspace policy say qualifies for a voucher?”

**Active-workspace sources retrieved:** `Refund_Compliance_SOP.pdf` and `QA_Batch_Recall.pdf`. No order rows were retrieved. The policy excerpts concerned QA-recall compensation for batches B-404/B-409; the requested order is batch B-100, so those recall terms do not establish that this order qualifies for recall compensation.

**Generated draft:** “I am checking on the delay and voucher status for order ORD-2026-1003. Could you please provide the specific purchase date and delivery details so I can verify your eligibility?”

**Ground truth in the active workspace's `orders` row:** status `Delayed`; delay `56` hours; `SLA_Voucher_Issued = true`; batch `B-100`.

**Accuracy:** Not useful/incomplete. It did not provide the known delay or voucher status, and asked for purchase and delivery details even though the order was identified. It also did not distinguish the retrieved recall-only voucher policy from a policy for ordinary shipment delays.

**Exact reason:** The running RAG's candidate sheet schemas included only `products`, `electronics_inventory`, and `grocery_inventory`; `orders` was not a candidate. Consequently, the retrieval result had no order row. The returned document chunks did not match this order's B-100 batch and did not provide a general 56-hour shipment-delay rule.

**Prompt tokens:** 2,916.

### Test 2 — Veloura Apparel

**Workspace ID:** `684a8863-5094-4c8b-9b15-c50c06335b7f`

**Customer message:** “For backorder BO-2001, what product and SKU was requested, how many units remain outstanding, and does the allocation policy give this buyer priority over standard buyers?”

**Active-workspace sources retrieved:** `Allocation Priority Policy.pdf` and `Port Receiving Manifest.pdf`. The allocation policy specifically names BO-2001, its 12-unit request, and the rule that Priority-tier open backorders receive full requested allocation before Standard-tier backorders. The retrieved sheet rows were unrelated `products` rows; no `backorders_dataset` row was retrieved.

**Generated draft:** “For backorder BO-2001, the requested product is the Classic Short-Sleeve Polo (Black) with SKU VL-POLO-BLK. There are 12 units requested. Yes, the allocation policy grants priority to accounts in the Priority Buyer Tier, ensuring 100% of their requested quantity is allocated first.”

**Ground truth in the active workspace's `backorders_dataset` row:** product `Classic Short-Sleeve Polo (Black)`, SKU `VL-POLO-BLK`, 12 requested, 0 allocated, status `Pending`, buyer tier `Priority`; therefore 12 remain outstanding.

**Accuracy:** Partially useful, but it does not explicitly answer the outstanding quantity. Its product, SKU, requested quantity, and policy-priority statements match available workspace evidence. It does not claim that allocation has already occurred.

**Exact reason:** The retrieval did not include the current backorder row, so it lacked `quantity_allocated = 0` and `fulfillment_status = Pending`. The policy PDF supplied the requested quantity and priority rule, but not the current allocation state needed to confirm the unfilled balance.

**Prompt tokens:** 4,277.

### Test 3 — Hospital Management Demo Workspace

**Workspace ID:** `52e50e84-197e-41f0-ba30-4bdeeabafa5e`

**Customer message:** “For Adult ICU North (HICU-01), how many clean beds are available, what are its staffed capacity and current occupancy, and what does the bed allocation policy say about prioritizing this unit?”

**Active-workspace sources retrieved:** `Hospital Bed Allocation Policy.pdf`. It states that an ICU is “Surge Ready” only when staffed beds minus occupied beds is at least 2 and clean beds are at least 2. No `hospital_units` rows were retrieved.

**Generated draft:** “While the policy states an ICU unit is Surge Ready when staffed beds minus occupied beds is at least 2 and clean beds is at least 2, the specific counts for Adult ICU North (HICU-01) are not available in the workspace context. Please check hospital_units.csv for HICU-01's current staffed capacity, occupancy, and clean bed numbers.”

**Ground truth in the active workspace's `hospital_units` row:** 4 clean beds, 20 staffed beds, 18 occupied beds, and 20 total beds.

**Accuracy:** Safe about the policy threshold, but not useful for the requested counts. It correctly disclosed that the counts were absent from the context it received; those counts are, however, present in the active workspace database.

**Exact reason:** The RAG candidate sheet schemas did not include `hospital_units`, so the unit row was not retrieved. The answer's statement that the values were unavailable in the prompt context was accurate; the failure was retrieval coverage, not invented numbers.

**Prompt tokens:** 839.

### Test 4 — Veloura Wholesale B2B Accounts Workspace

**Workspace ID:** `d47544a4-6e80-41bb-9ddf-e694c714b4fe`

**Customer message:** “For account ACC-1004 (Vanguard Garment Distributors), what is the overdue balance relative to its credit limit, and what does the Finance Credit Control Policy require when an account has an overdue balance?”

**Active-workspace sources retrieved:** `Finance Credit Control Policy.pdf` and `Q4 VIP Expansion Brief.pdf`. No `wholesale_accunts_dataset` rows were retrieved. The retrieved policy excerpts identify ACC-1004 as an overdue, high-spend account and state that it conflicts with the Q4 VIP retention rule.

**Generated draft:** “For account ACC-1004 (Vanguard Garment Distributors), the overdue balance is $1,850 against a credit limit of $10,000. Under the Finance Credit Control Policy, every account with an overdue balance is subject to an immediate 25% reduction in its credit limit and an immediate status transition to a Credit Hold, subject to the Q4 VIP Retention Protection Clause.”

**Ground truth in the active workspace's `wholesale_accunts_dataset` row:** overdue balance `$1,850`, credit limit `$10,000`, annual spend `$16,200`, current tier `Silver`, account status `Active`.

**Accuracy:** The account figures are correct, but the policy explanation is materially incomplete and could mislead an operator. It presents the strict 25% cut/Credit Hold as the operative rule and only vaguely qualifies it with “subject to” the VIP clause. It does not disclose that execution must pause for a Socratic choice. For ACC-1004, Option 1 cuts the limit to `$7,500` and applies Credit Hold; Option 2 preserves the `$10,000` limit and Active status during the 14-day retention grace.

**Exact reason:** This is a reasoning/clarification failure despite relevant evidence being retrieved: the finance policy and VIP brief explicitly say the ACC-1004 conflict must be resolved before execution and define the two outcomes. The sheet row was also not retrieved, but both policy documents contained the balance, limit, and account identity. The key missing behavior was surfacing the conflict and asking the operator to choose, rather than summarizing the default penalty.

**Prompt tokens:** 2,500.

### Cross-test findings

- The four active workspaces tested were exactly **Echo Demo Operations Workspace**, **Veloura Apparel**, **Hospital Management Demo Workspace**, and **Veloura Wholesale B2B Accounts Workspace** (IDs listed with each test).
- All four prompts asked for workspace-specific facts, and none of the four RAG results included the matching structured row. Veloura's response was partly correct based on its retrieved policy document but did not answer the outstanding-balance subquestion. The B2B response also failed to honor an explicitly retrieved conflict/clarification rule.
- In the tested process, `getCandidateSheetSchemas()` returned only `products`, `electronics_inventory`, and `grocery_inventory`. Active-workspace datasets such as `orders`, `backorders_dataset`, `hospital_units`, and `wholesale_accunts_dataset` were not registered as candidate schemas, and therefore their rows were not supplied to the reply prompt. For Veloura and B2B, text inside the PDFs happened to include some dataset values, but did not replace retrieving current row state.
- Separately, the B2B case shows that adding row retrieval alone is not sufficient: the prompt/model must preserve policy conflicts and request an explicit choice when the source documents mandate a Socratic gate.

## Automated verification

- `npm --prefix backend test` — **passed: 68 tests, 0 failures**.
- `Set-Location backend; npm run typecheck` — **passed** (`tsc --noEmit`).
- `npm --prefix frontend run build` — **passed** (TypeScript and Vite production build).
- The frontend build emitted a bundle-size advisory because the generated JavaScript chunk is larger than 500 kB. It did not fail the build.

The backend tests cover that posting messages does not invoke generation, workspace-only retrieval, recent-message context, ownership checks, generation failure behavior, draft freshness, and the reply-draft workflow.

## Files changed for this work

- `backend/src/controllers/conversationController.js`
- `backend/src/routes/businessRoutes.js`
- `backend/src/services/conversationService.js`
- `backend/src/services/promptBuilderService.js`
- `backend/test/workflow.test.js`
- `backend/db/migrations/011_clear_legacy_ai_reply_drafts.sql`
- `frontend/src/pages/CompanyDashboard.jsx`
- `frontend/src/services/api.ts`
- `frontend/src/store/companySlice.js`
- `frontend/dist/index.html`
- `frontend/dist/assets/index-CbxvnRZO.js` (generated build output)

The worktree already contained unrelated changes, including other `frontend/dist` deletions and files. Those were left untouched.

## Remaining limitations

- The earlier four live checks used synthetic records/documents. The additional four used existing demo-workspace database rows and documents, as identified above. All eight were generation/retrieval-only checks; no conversation messages or drafts were saved, no spreadsheet data was changed, and no email was sent.
- Replies remain model-generated drafts and should be reviewed by the company agent before sending.
- The frontend was typechecked and production-built; an interactive browser click-through was not part of this verification.
- Gemini output can still vary. The prompt requires unknown policy prerequisites to be requested before confirming eligibility, but human review remains appropriate for consequential customer decisions.
