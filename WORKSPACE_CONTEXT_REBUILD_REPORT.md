# Workspace Context Rebuild and Grounding Test Report

## Summary

The four authorized demo workspaces were rebuilt from their workspace-specific CSV and PDF assets. Workspace table profiles and document breadcrumbs are available for retrieval. The live checks show good document/table grounding for Echo, Apparel, and Wholesale after a retrieval correction. The Hospital Q&A is also grounded and accurate.

The Hospital operation preview is **not reliable yet**: Gemini’s eligibility IDs and its own numeric explanation disagree. One live attempt produced a preview that included an ineligible unit; a later attempt stopped at clarification. Neither attempt was confirmed, so no data or emails were changed. This limitation is detailed below.

## Workspace and source mapping

| Workspace | Active table(s) | Documents |
|---|---|---|
| Echo Demo Operations Workspace (`11111111-2222-3333-4444-555555555555`) | `orders` — 20 rows | `Commercial Orders Dataset.csv`; `QA_Batch_Recall.pdf`; `Refund_Compliance_SOP.pdf` |
| Veloura Apparel (`684a8863-5094-4c8b-9b15-c50c06335b7f`) | `products` — 15 rows; `backorders_dataset` — 13 rows | `products.csv`; `backorders_dataset.csv`; `Allocation Priority Policy.pdf`; `Port Receiving Manifest.pdf` |
| Veloura Wholesale B2B Accounts Workspace (`d47544a4-6e80-41bb-9ddf-e694c714b4fe`) | `wholesale_accunts_dataset` — 16 rows | `wholesale_accunts_dataset.csv`; `Finance Credit Control Policy.pdf`; `Q4 VIP Expansion Brief.pdf` |
| Hospital Management Demo Workspace (`52e50e84-197e-41f0-ba30-4bdeeabafa5e`) | `hospital_units` — 5 rows | `hospital_units.csv`; `Hospital Bed Allocation Policy.pdf` |

The rebuilt PDF chunk counts were Echo 16, Apparel 16, Wholesale 18, and Hospital 5. The Risedual workspace was excluded as requested. The empty Nexus workspace remains absent.

## Four workspace checks: prompts and actual results

Each workspace received one knowledge question and one policy-aware operation request. These are eight distinct prompts; the knowledge questions require records from the active workspace, not general knowledge.

### 1. Echo Demo Operations Workspace

**Knowledge prompt**

> According to the QA Batch Recall report and orders.csv, how many undelivered orders contain recalled batches B-404 or B-409, what clean replacement batch is staged, and which shipment tier is required?

**Generated reply:** “According to our QA Batch Recall report, exactly 4 undelivered orders contain recalled batches B-404 or B-409 (ORD-2026-1015, ORD-2026-1017, ORD-2026-1018, and ORD-2026-1020). The staged clean replacement batch is B-501, and the required shipment tier is Expedited.”

**Result:** Accurate. The retrieval included `orders` rows and both recall/SOP sources.

**Operation prompt**

> Find all undelivered or processing orders in orders.csv containing defective batches from the QA Batch Recall report, swap them to clean replacement batches with expedited shipping per our Refund & Replacement SOP, and email the customers their updated fulfillment details.

**Preview result:** `CLARIFICATION_REQUIRED`; 4 affected orders and 2 conflicting orders. The conflict was existing promo discounts/high-subtotal governance on ORD-2026-1018 and ORD-2026-1020. No mutation preview was approved or executed.

### 2. Veloura Apparel

**Knowledge prompt**

> From the Port Receiving Manifest and backorders_dataset.csv, what net quantity passed QC for SKU VL-POLO-BLK, and how many open units are requested for that SKU?

**Generated reply:** “For SKU VL-POLO-BLK (Classic Short-Sleeve Polo), exactly 40 units net passed QC inspection from the Port Receiving Manifest (out of 60 manifested units, with 20 units rejected due to moisture damage). Across the 6 open pending rows in backorders_dataset.csv, there are currently 60 total units requested.”

**Result:** Accurate; it used the manifest and backorder data.

**Operation prompt**

> Reconcile the newly arrived inventory in the Port Receiving Manifest against open backorders in backorders_dataset.csv and update remaining available stock in products.csv according to our Allocation Priority Policy, then notify affected backorder buyers by email.

**Preview result:** `CLARIFICATION_REQUIRED`; 7 affected rows (6 backorders plus the product row), 7 conflicting rows. The system calculated 64 total units available against 60 backorder units plus a 10-unit minimum storefront buffer (70 required), a six-unit deficit. It offered allocation choices rather than executing. No mutation or email was executed.

### 3. Veloura Wholesale B2B Accounts Workspace

**Knowledge prompt**

> Using wholesale_accunts_dataset.csv and the Q4 VIP Expansion Brief, which overdue account identifiers qualify for the VIP retention grace period, and what is the qualifying policy rule?

**Initial generated reply:** “Accounts ACC-1004 and ACC-1007 qualify for the Q4 VIP 14-Day Retention Grace Period because they either hold Gold tier status or have a cumulative annual spend of USD 15,000 or greater while carrying an overdue balance.”

The initial retrieval returned zero table rows, so this answer was accurate but not proven against the active CSV. That was a retrieval defect, not evidence of successful table grounding.

**After the retrieval fix:** the active table retrieval returned ACC-1004, ACC-1008, ACC-1009, ACC-1016, and ACC-1007. The regenerated reply correctly identified ACC-1004 and ACC-1007 and stated the same Gold-tier-or-USD-15,000-spend rule with a positive overdue balance. The issue is considered corrected for this test.

**Operation prompt**

> Audit all accounts with overdue balances in wholesale_accunts_dataset.csv under Finance Credit Control Policy FIN-POL-008 Section 5 and Q4 VIP Expansion Brief Section 5. Apply the required credit-limit and account-status changes, then email impacted account managers.

**Preview result:** `CLARIFICATION_REQUIRED`; 5 overdue accounts and 2 VIP-protected conflicting accounts (ACC-1004 and ACC-1007). This is a policy conflict requiring an operator choice. No mutation or email was executed.

### 4. Hospital Management Demo Workspace

**Knowledge prompt**

> According to hospital_units.csv and the Hospital Bed Allocation Policy, which ICU units currently qualify as Surge Ready, and what bed-count conditions must they meet?

**Initial generated reply** lacked the CSV facts and asked for the unit data. After checking retrieval, it returned all five hospital rows and the regenerated reply was:

> Based on the Hospital Bed Allocation Policy, an ICU unit qualifies as Surge Ready only when the department is ICU, staffed_beds minus occupied_beds is at least 2, and clean_beds is at least 2. Reviewing the current records, HICU-01 has 20 staffed beds, 18 occupied beds (leaving a difference of 2), and 4 clean beds, making it Surge Ready. HICU-02 has 16 staffed beds and 15 occupied beds (a difference of 1), so it does not qualify. HICU-03 has 10 staffed beds and 10 occupied beds (a difference of 0) and only 1 clean bed, so it does not qualify.

**Result:** Accurate and grounded in `hospital_units.csv` plus the policy.

**Operation prompt**

> Set surge_status to "Surge Ready" for every ICU unit meeting the policy staffed-bed-minus-occupied and clean-bed thresholds. Draft a notification to the charge nurse for each changed unit.

**Preview result and limitation:** The model was inconsistent across live attempts:

- One attempt returned `PREVIEW_READY` with HICU-02 and HICU-01, even though its policy rule and row values show HICU-02 fails the staffing threshold. This would have been an incorrect preview. It was **not confirmed**.
- A later attempt returned `CLARIFICATION_REQUIRED`, but still listed HICU-02, HICU-03, and HICU-01 as affected and treated the explicit notification request as a conflict with the policy’s “notify only when explicitly requested” condition.
- The latest attempt produced no preview. The system’s latest result is therefore fail-closed, but the operation interpretation is not dependable.

**Root cause:** Gemini’s prose correctly computes the threshold failures, but its structured row-ID/conflict fields do not consistently follow that reasoning. Prompt clarification improved the fail-closed outcome in the latest attempt but did not make the structured eligibility result reliable. A deterministic eligibility-validation step (or a validated, typed policy-rule representation) is still needed before treating policy-derived previews as safe.

No Hospital operation was confirmed, and no notification was sent.

## Root causes found and changes made

1. **Wholesale reply retrieval ignored policy-document entity IDs.** Table filtering used identifiers extracted only from the user’s message. Policy references such as `FIN-POL-008` are not account IDs, so the exact-ID query returned no account rows; the reply then relied on document text alone. Retrieval now also uses identifier-like entities extracted from the relevant document chunks, with a bounded identifier set and tenant-scoped query. The live recheck returned the five overdue accounts.
2. **Identifier misses previously had no useful fallback.** A bounded, tenant-scoped fallback fetch is now used when identifier filtering finds no rows, rather than silently presenting an empty result.
3. **Policy operation instructions needed clearer separation of eligibility and governance.** The operation prompt now says ineligible rows are not conflicts, numeric conditions must use the exact named columns, and a satisfied authorization prerequisite is not itself a conflict. The Hospital live results show prompt changes alone are not sufficient; see the limitation above.
4. **Table citations could expose contact data.** Row citation excerpts now omit email, phone, mobile, and address fields.

Files changed for these follow-up fixes:

- `backend/src/services/crossRagService.js`
- `backend/src/services/socraticOperationsService.js`
- `backend/test/workspaceContext.test.js`

The broader workspace-context implementation and rebuild utility are in `backend/db/migrations/012_workspace_context_catalog.sql`, `backend/src/services/workspaceTableMetadataService.js`, `backend/src/services/documentIngestionService.js`, `backend/src/services/queryRouterService.js`, `backend/src/services/workspaceIntentRouter.js`, `backend/src/services/promptBuilderService.js`, and `backend/scripts/rebuild_workspace_context.js`, with related controller/import/sync and test updates.

## Token and latency observations

- The original four-workspace live run logged **89,173 Gemini input tokens across 12 calls**. The individual scenario durations recorded by the runner were Echo 24,042 ms, Apparel 110,534 ms, Wholesale 12,702 ms, and Hospital 8,220 ms.
- Follow-up live rechecks logged another **45,075 input tokens across 10 calls**, for **134,248 observed input tokens across 22 calls** in total. These are logged prompt-token counts, not a before/after comparison.
- There is no comparable pre-change token baseline, so a token reduction cannot be claimed. Follow-up recheck elapsed times were not measured consistently enough to report.

## Verification and safety

- `npm test`: **74 passed, 0 failed**.
- `npm run typecheck`: **passed**.
- Focused `workspaceContext.test.js`: **6 passed, 0 failed**.
- Live Gemini checks were run for the four named workspaces. The Wholesale and Hospital grounding checks were repeated after the retrieval/prompt changes.
- All operation tests stopped at clarification or preview. No `confirm-operation` call was made; no spreadsheet rows were mutated and no emails were dispatched.
- Temporary Socratic workflows created by the rechecks were deleted. The workflow row count returned to its prior value of 3.
- Verification confirmed all Hospital `surge_status` values remained `Standard`, ACC-1004/ACC-1007 remained `Active` with their original credit limits, and Nexus remained absent.

## Remaining limitations

- Hospital policy-derived operation previews must not be trusted until structured eligibility is checked deterministically against the actual row values. The observed inconsistent preview is documented above.
- The reply/retrieval checks are live samples, not exhaustive tests of every workspace schema or every operation type.
- No pre-change Gemini token baseline is available.

## Latest analytical-read follow-up

### Failure reproduced and root cause

The original live Hospital read returned HICU-02 in `highlighted_rows` even though the generated prose correctly said it failed the staffed-bed threshold. Inspection of the actual structured plan showed that Gemini returned filters for `department = ICU` and `clean_beds >= 2`, but omitted the policy's derived condition `staffed_beds - occupied_beds >= 2`. The SQL therefore returned a broader row set than the answer described. Separately, calculated filters had been grouped with ordinary filters under `filter_logic`; an `OR` plan could have bypassed a policy eligibility condition even when Gemini did include it.

### Changes made

- Calculated eligibility clauses are now appended as separate mandatory `AND` conditions. User-requested `OR` applies only among ordinary filters.
- For eligibility questions, a generic extractor looks for arithmetic inequalities in retrieved policy passages using exact active-schema numeric columns. It adds validated, parameterized SQL expressions to the selected table plan; if the request requires an arithmetic eligibility test and no safe expression is available, plan validation fails closed and requests correction rather than returning unfiltered rows.
- Reply retrieval no longer treats an internal conversation UUID as a business record identifier. Relevant document terms are also used to retrieve and score rows from the active workspace, allowing policy passages and table records to be cross-referenced.
- Empty identifier-column matches no longer produce malformed empty SQL predicates; retrieval falls through to the bounded, tenant-scoped text path.
- The in-memory PostgreSQL test fixture now recognizes the tenant-scoped, parameterized dynamic-table query shape used by retrieval.

### Live verification

Prompt used:

> According to the Hospital Bed Allocation Policy and hospital_units.csv, which ICU units satisfy the Surge Ready rule? Calculate staffed beds minus occupied beds and exclude units below either threshold.

The verified SQL result contained **HICU-01 and HICU-04 only**. HICU-02 was excluded because 16 staffed beds minus 15 occupied beds is 1, below the required 2. The grounded answer also noted that HICU-01 has a staffing gap of 2 and therefore requires the policy's float-roster conflict resolution before an automated surge classification. This was a read-only check; no operation workflow was confirmed, no data changed, and no email was sent.

The successful Gemini-backed check logged 13,086 input tokens over three calls (intent routing, read planning, and answer synthesis). This is an observation for this run, not a comparable before/after benchmark.

### Current verification results

- Backend `npm test`: **78 passed, 0 failed**.
- Focused `workspaceContext.test.js`: **10 passed, 0 failed**, including parameterization/tenant scoping, OR-vs-calculated-filter enforcement, and fail-closed plan validation.
- Backend `npm run typecheck`: **passed**.
- Frontend `npm run typecheck`: **passed**.
- `git diff --check`: **passed** (Git emitted only existing Windows line-ending conversion warnings).
- The live customer-reply helper also returned an ACC-1004 workspace-grounded draft with citations from the Wholesale policy documents and the matching receivables table.

### Files touched by the current follow-up

- `backend/src/services/workspaceReadService.js` (new)
- `backend/src/services/crossRagService.js`
- `backend/src/services/workspaceReplyService.js` (new)
- `backend/test/workspaceContext.test.js` (new)
- `backend/test/workflow.test.js`
- `WORKSPACE_CONTEXT_REBUILD_REPORT.md`

The connected workspace-RAG, intent, reply, and UI integration files in this implementation are:

- `backend/src/services/geminiService.js`
- `backend/src/services/workspaceIntentRouter.js`
- `backend/src/services/queryRouterService.js`
- `backend/src/services/socraticOperationsService.js`
- `backend/src/services/promptBuilderService.js`
- `backend/src/controllers/conversationController.js`
- `backend/src/controllers/workspaceController.js`
- `frontend/src/services/api.ts`
- `frontend/src/components/SocraticOperationsWorkbench.tsx`
- `shared/types/contracts.ts`

### Remaining limitations after this follow-up

- The fix makes analytical read rows obey extracted policy arithmetic; it does **not** make the separate Socratic mutation compiler deterministically validate every eligibility rule. The Hospital `surge_status` mutation preview remains untrusted until that write path validates the same policy predicates against actual rows.
- The Stage-1 execution blueprint is not yet a validated artifact carried into Socratic Turn 2. Multi-table completion and row-level email-recipient integrity therefore remain limitations; this run did not test or execute a multi-table mutation or send email.
- Deterministic document-derived eligibility extraction currently recognizes direct subtraction inequalities whose operands map to numeric columns in the active schema. Other prose formulas must be emitted as valid `calculation_filters` by Gemini or the request fails closed; formulas over nested JSON are not inferred.
