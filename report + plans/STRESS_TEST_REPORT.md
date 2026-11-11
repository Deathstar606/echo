# Mutation Preview Fix and Workspace Stress Test

Date: 2026-11-08

## Summary

The mutation preview was being produced by the existing sheet mutation API, but
the workbench routed the result into a conversational message and the spreadsheet
panel did not render its Redux `mutationPreview` state. The user therefore saw
neither the diff nor the confirmation control.

The second issue was a backend safety gap: normal validation rejected an update
without filters unless `match_all` was true, but it trusted that flag even when
the natural-language request did not ask for a whole-table operation. The
prompt builder advised Gemini to set it only for explicit whole-table requests;
that instruction was not an execution-time safeguard.

## Changes

- Restored a visible spreadsheet mutation preview card with per-record
  before/proposed values, a confirmation-required state, **Confirm & Apply**,
  and **Discard** actions.
- The preview card resolves a useful record label from the full target row when
  the diff contains only a UUID.
- Starting a new preview clears any previous approved preview immediately, so a
  failed or ambiguous follow-up cannot leave a stale **Confirm & Apply** action
  visible.
- Clarification-needed, no-match, loading, and API error states are now displayed
  in the spreadsheet panel. A clarification has no confirmation action.
- Added a prompt-aware backend guard at both preview and execution. An unfiltered
  `match_all` update or delete is accepted only when the original request clearly
  specifies a whole-table scope. A qualified request such as “all luxury shirts”
  without its corresponding filter returns `clarification_needed`. Filtered
  mutations and explicit whole-table requests remain supported.
- Created an isolated Hospital Management workspace with synthetic data:
  - `demo-workspaces/Hospital Management Workspace/Hospital Bed Allocation Policy.pdf`
  - `demo-workspaces/Hospital Management Workspace/hospital_units.csv`
- Created and populated a separate test business in PostgreSQL:
  `Hospital Management Demo Workspace`
  (`52e50e84-197e-41f0-ba30-4bdeeabafa5e`). It contains five hospital-unit rows
  and the uploaded policy document; no email was sent.

## Root-Cause / Safety Verification

Before editing, I called `validateMutation` with an update plan containing
`match_all: true` and no filters. The backend accepted it with zero target
filters. This confirmed that the prompt instruction alone did not prevent an
accidental whole-table update.

The added regression test now verifies:

1. A prompt with no target scope returns `clarification_needed`.
2. A qualified “all luxury shirts / all sizes” prompt is not treated as an
   instruction to update every table row when its filter is missing.
3. An unscoped `match_all` plan submitted directly for confirmation does not
   change any rows.
4. An explicit “all rows in the table” request can still produce a preview.

## Stress-Test Results

### Real workspace fixture audit

All available PDFs were extracted with the application PDF parser, and all
attached CSVs were parsed and checked against the policy constraints. These
fixture checks used the actual files under `demo-workspaces`; they did not send
their contents to Gemini or mutate those workspaces.

| Workspace | Prompt / scenario checked | Fixture result |
|---|---|---|
| Echo Demo Operations Workstation | “Find all undelivered or processing orders in orders.csv containing defective batches from the QA Batch Recall report, swap them to clean replacement batches with expedited shipping per our Refund & Replacement SOP, and email the customers their updated fulfillment details.” | 20 orders parsed. The recalled `B-404`/`B-409` processing/pending cohort is exactly `ORD-2026-1015`, `1017`, `1018`, and `1020`; shipped, delivered, and clean-batch records are excluded. SOP data indicates two clean auto-eligible rows and two governance conflicts. |
| Veloura Apparel | “Reconcile the newly arrived inventory in the Port Receiving Manifest against open backorders in backorders_dataset.csv and update remaining available stock in products.csv according to our Allocation Priority Policy, then notify affected backorder buyers by email.” | 13 backorders and 15 products parsed. Six open polo backorders total 60 units; the storefront has 24 units and the manifest contributes 40 net units. The policy requires 70 units including its 10-unit buffer, so the intended safe outcome is a clarification gate, not silent allocation. |
| Veloura Wholesale B2B Accounts Workspace | “Upgrade all Silver accounts with annual spend of at least $10,000 to Gold under the Q4 VIP brief, applying the credit-control policy and notifying the account managers.” | 16 accounts parsed; six are in the upgrade cohort and two have overdue balances that conflict with credit expansion. |
| Veloura Wholesale B2B Accounts Workspace | “Audit all accounts with overdue balances, reduce their credit limits by 25%, place them on credit hold, and notify their account managers.” | Five overdue accounts parsed; two meet the brief’s VIP retention-protection condition and should trigger clarification. |
| [Risedual Documents] | “Apply the end-of-season 20-percentage-point discount to in-stock summer and luxury shirts, honoring the pricing policy and sending the buyer announcement.” | Four PDFs parsed. Pricing policy includes a 30% cap and BDT 1,200 net-price floor; the memo requests +20 percentage points and requires a conflict gate. This folder has no CSV, so a table mutation cannot be exercised against it. |
| [Risedual Documents] | “Identify delayed orders affected by the supplier delay notice and apply the SLA voucher policy.” | The supplier notice and 48-hour/10% SLA documents parse, but there is no attached orders CSV in this workspace folder. A live table operation cannot be verified without a table. |

The supplied workflow IDs
`84d1b685-ab45-4dcd-a6d9-e6c95b11ca9f` and
`ed220230-c579-41f0-9a15-3515ed98bfb4` were not present in the current
`socratic_workflows` database table. Their scenario prompts were checked against
the available workspace fixtures, but the prior workflow instances themselves
could not be resumed.

### Hospital workspace application run

The hospital files were uploaded through the workspace API under the new
business above. Gemini responses were deterministic test stubs; no external
Gemini call was made.

| Prompt | Observed result |
|---|---|
| “Set surge_status to 'Surge Ready' for ICU units with staffing_gap of 2 or more and at least 2 clean beds.” | Routed as `SHEET_MUTATION`; preview showed one row (`Adult ICU North`) changing from `Standard` to `Surge Ready`; confirmed execution updated only `HICU-01`. |
| “List the ICU units already marked Surge Ready.” | Routed as `SHEET_QUERY`; returned exactly `HICU-01`. |
| “Update the ICU beds.” | Returned `clarification_needed` asking which bed field and target value; no mutation was applied. |
| “What does the uploaded bed allocation policy require for ICU surge readiness?” | Routed as a document question and answered using the uploaded policy context. |

The hospital PDF was persisted as five indexed chunks. The final database state
was independently read back: five hospital rows, one `Surge Ready` row, and the
uploaded policy document.

### PDF chunking assessment

The 10 existing demo PDFs produced 62 chunks total (4–9 chunks per document).
PDF extraction in this run took approximately 4.7–64.7 ms per file. The proposed
summary-only indexing was not implemented: these documents are currently small
in extracted text/chunk count, and summarization could drop exact batch IDs,
cohort exclusions, thresholds, or policy exceptions that drive safe decisions.
The measurements do not show that summarization would improve end-to-end prompt
latency enough to justify that correctness risk.

## Verification Commands and Results

- `Set-Location backend; node --import tsx --test test/universalSheet.test.js`
  — **30 passed, 0 failed**.
- `npm --prefix backend run typecheck` — **passed**.
- `npm --prefix frontend run build` — **passed** (TypeScript check and Vite
  production build).
- Mutation preview reducer regression check — **passed**; a new request clears
  the old preview and enters the loading state.
- `node --check backend/src/services/sheetMutationService.js` and
  `node --check backend/src/controllers/sheetController.js` — **passed**.
- Demo workspace fixture audit — **passed** for all attached PDFs and CSVs.
- Hospital API upload/query/preview/confirmation/clarification run — **passed**
  with Gemini stubs.
- `npm --prefix backend test` — **54 passed, 14 failed**. The failures are in
  `test/sheetWorkflow.test.js` and cascade from the already-missing
  `backend/products.csv` fixture (`ENOENT`). That file was already deleted in
  the pre-existing worktree and was not restored or modified.

## Files Changed or Added

Source changes:

- `backend/src/services/sheetMutationService.js`
- `backend/src/controllers/sheetController.js`
- `backend/test/universalSheet.test.js`
- `frontend/src/components/SheetManagementPanel.tsx`
- `frontend/src/store/sheetSlice.js`

Requested hospital workspace:

- `demo-workspaces/Hospital Management Workspace/Hospital Bed Allocation Policy.pdf`
- `demo-workspaces/Hospital Management Workspace/hospital_units.csv`

Generated build output:

- `frontend/dist/index.html`
- `frontend/dist/assets/index-D2wxTKmR.js`
- `frontend/dist/assets/index-NWXq0u9E.css`

## Limitations

- The normal Gemini service was not called; intent routing and sheet
  interpretations in the hospital API run used deterministic test stubs.
- The two named workflow IDs were not available in the live workflow table.
- The Risedual fixture has policies but no CSV, preventing a full table workflow.
- The full backend test command remains blocked by the pre-existing deleted
  `backend/products.csv` fixture.
