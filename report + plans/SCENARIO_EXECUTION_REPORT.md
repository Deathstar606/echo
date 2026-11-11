# Scenario Execution Report — 3 New Multi-Hop B2B Scenarios

**Date:** 2026-11-08 · **Suite:** [`verify_three_new_scenarios.js`](file:///c:/Users/USER/Desktop/Development/Echo/backend/tests/verify_three_new_scenarios.js) (`npm --prefix backend run test:three-new`)
**Raw telemetry:** [`three_new_scenarios_results.json`](file:///c:/Users/USER/Desktop/Development/Echo/backend/tests/three_new_scenarios_results.json) (run 1), [`three_new_scenarios_results_run2.json`](file:///c:/Users/USER/Desktop/Development/Echo/backend/tests/three_new_scenarios_results_run2.json) (run 2)

## 1. Executive Summary

| # | Workspace | Business ID | Turn 1 | Turn 2 | Turn 3 | Checks |
|---|---|---|---|---|---|---|
| 1 | Echo Demo Operations Workspace | `11111111-2222-3333-4444-555555555555` | `CLARIFICATION_REQUIRED` (4 affected / 2 conflicting) | `PREVIEW_READY` (4 mutations, 4 emails) | `EXECUTED` (4 rows) | **13/13** |
| 2 | Veloura Apparel | `684a8863-5094-4c8b-9b15-c50c06335b7f` | `CLARIFICATION_REQUIRED` (7 affected across 2 tables) | `PREVIEW_READY` (7 mutations in 2 tables, 6 emails) | `EXECUTED` (7 rows, one transaction) | **10/10** |
| 3 | Veloura Wholesale B2B Accounts Workspace | `d47544a4-6e80-41bb-9ddf-e694c714b4fe` | `CLARIFICATION_REQUIRED` (5 affected / 2 conflicting) | `PREVIEW_READY` (5 mutations, 5 emails) | `EXECUTED` (5 rows) | **13/13** |

**Result: 3/3 scenarios PASS on 2 back-to-back runs (36/36 checks each run).**

**Latency, run 1 (run 2):**

| Scenario | Turn 1 | Turn 2 | Turn 3 |
|---|---|---|---|
| S1 | 6.76 s (6.77 s) | 3.98 s (3.92 s) | 0.44 s (0.46 s) |
| S2 | 7.23 s (6.82 s) | 4.27 s (4.53 s) | 0.66 s (0.62 s) |
| S3 | 6.02 s (6.59 s) | 4.29 s (4.18 s) | 0.54 s (0.51 s) |

**Model:** `gemini-3.5-flash-lite`.

**Gates:**

| Gate | Result |
|---|---|
| `npm --prefix backend run typecheck` | ✅ exit 0 |
| `npm --prefix backend test` | ✅ 67/67 |
| `npm --prefix backend run test:demo` (SLA regression) | ✅ PASS |
| `npm --prefix frontend run build` | ✅ exit 0 |

> Turn 3 ran with `dry_run: true`. Database mutations are fully committed and checked with SQL. Emails are compiled, validated against the recipient allow-list and recorded in the dispatch ledger, but not sent over SMTP.

## 2. Context Audit & In-Place Enrichments

No new workspaces or filenames were created. Every file below already existed and was updated in place, then re-ingested.

| Workspace | File | Gap found | In-place update |
|---|---|---|---|
| 1 | [`Commercial Orders Dataset.csv`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_0/Commercial%20Orders%20Dataset.csv) → table `orders` | Stored as an `.xlsx` container; had no batch, shipping-tier, promo or refund columns | Converted to clean UTF-8 CSV (20 rows × 21 cols). Added `Batch_Code`, `Shipping_Tier`, `Promo_Discount_Pct`, `Refund_Status` and recall rows `ORD-2026-1012…1020`. The original SLA rows are kept, so `test:demo` still passes. |
| 1 | [`QA_Batch_Recall.pdf`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_2/QA_Batch_Recall.pdf) | No clean replacement batch; no rule for undelivered orders | Added §4: clean batch `B-501`, a Processing-only scope, and explicit exclusion of Shipped, Delivered and `B-401` rows |
| 1 | [`Refund_Compliance_SOP.pdf`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_2/Refund_Compliance_SOP.pdf) | No pre-shipment swap clause | Added §4: promo-stacking / high-value (≥ 25,000 BDT) gate with Option 1 and Option 2 |
| 2 | [`products.csv`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_1/products.csv) | No SKU link between catalog and manifest | Added `(Catalog SKU: …)` to `description` only; no other column changed |
| 2 | [`Port Receiving Manifest.pdf`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_4/Port%20Receiving%20Manifest.pdf) | Did not reference the products storefront stock | Links `VL-POLO-BLK` to "Classic Short-Sleeve Polo": 24 in storefront + 40 net arrived = 64 |
| 2 | [`Allocation Priority Policy.pdf`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_4/Allocation%20Priority%20Policy.pdf) | No cross-table rule | Added §4: 10-unit Minimum Storefront Buffer with multi-table Options 1 and 2 |
| 2 | [`backorders_dataset.csv`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_4/backorders_dataset.csv) | — (already sufficient) | Re-ingested unchanged (13 rows) |
| 3 | [`wholesale_accunts_dataset.csv`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_3/wholesale_accunts_dataset.csv) | Live DB still held mutated rows from an earlier run | Re-uploaded the clean 16-row baseline |
| 3 | [`Finance Credit Control Policy.pdf`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_3/Finance%20Credit%20Control%20Policy.pdf) / [`Q4 VIP Expansion Brief.pdf`](file:///c:/Users/USER/Desktop/Development/Echo/backend/demo/scenario_3/Q4%20VIP%20Expansion%20Brief.pdf) | No overdue-audit clause | Added §5: overdue audit (−25 % limit + Credit Hold) vs. Q4 VIP 14-day retention grace (Gold or spend ≥ 15,000) |

**Re-ingestion counts (each run):**

| Workspace | Documents | Table rows |
|---|---|---|
| 1 | 2 docs / 14 chunks | `orders` = 20 |
| 2 | 2 docs / 14 chunks | `products` = 15, `backorders_dataset` = 13 |
| 3 | 2 docs / 14 chunks | `wholesale_accunts_dataset` = 16 |

The spelling `wholesale_accunts_dataset` is the actual name used both on disk and in PostgreSQL.

> [!NOTE]
> The enriched policy PDFs include worked examples (exact row IDs and target values). This follows the instruction to make each file contain enough to resolve its scenario *deterministically*. The backend does not hard-code any of these values. Every row ID, number and status comes from the documents and tables at runtime.

## 3. Backend Changes (generic, schema-agnostic)

- **[`workspaceIntentRouter.js`](file:///c:/Users/USER/Desktop/Development/Echo/backend/src/services/workspaceIntentRouter.js):** new `target_entities[]` output. Gemini lists every table the user explicitly asks to inspect or update. Each name is checked against the business's real tables, and nothing falls back to `orders`.
- **[`queryRouterService.js`](file:///c:/Users/USER/Desktop/Development/Echo/backend/src/services/queryRouterService.js):** returns `targetTables[]` (primary table first) and cites rows from every involved table. `targetTable` is kept for backward compatibility.
- **[`socraticOperationsService.js`](file:///c:/Users/USER/Desktop/Development/Echo/backend/src/services/socraticOperationsService.js):**
  - Rows from multiple tables are shown to the model tagged with `_table_name`, and each mutation carries a `table_name`.
  - JSON-map columns (e.g. `products.size`) are flagged `nested_map_json`. Their values are validated as non-negative numeric objects and compared by content, not string form.
  - Recipient list spans all target tables.
  - Turn 3 commits all `UPDATE`s across all tables inside one `withTransaction`.
- No literal SKUs, filenames, column names or business IDs were added under `backend/src/`.

## 4. Scenario Execution Logs (run 1)

### Scenario 1 — Recall Batch Swap (Workspace 1)

**Prompt:** *"Find all undelivered or processing orders in orders.csv containing defective batches from the QA Batch Recall report, swap them to clean replacement batches with expedited shipping per our Refund & Replacement SOP, and email the customers their updated fulfillment details."*

**Turn 1 — `CLARIFICATION_REQUIRED`** (workflow `84d1b685-ab45-4dcd-a6d9-e6c95b11ca9f`)
- 4 affected rows: `ORD-2026-1015, 1017, 1018, 1020`.
- 2 conflicting rows: `ORD-2026-1018` (promo 10 %) and `ORD-2026-1020` (promo 15 %, subtotal 28,000 BDT ≥ 25,000).
- Options:
  - `option_1`: Swap to B-501 + Expedited and **preserve** promos (selected).
  - `option_2`: Strip promos on the conflicting orders.
- Citations: `QA_Batch_Recall.pdf`, `Refund_Compliance_SOP.pdf`, table `orders`.

**Turn 2 — `PREVIEW_READY`**

| Row | Before | After |
|---|---|---|
| ORD-2026-1015 / 1017 / 1018 / 1020 | `Batch_Code` B-404/B-409, `Shipping_Tier` Standard, `Dispatch_Status` Processing, `Refund_Status` None | `B-501`, `Expedited`, `Ready for Expedited Dispatch`, `Replacement Swapped (B-501)` |

- `Promo_Discount_Pct` was not touched (0 / 0 / 10 / 15).
- 4 emails: Sadia Mehzabin, Jannatul Ferdous, Mustafizur Rahman, Rumana Akter. Sample: *"Dear Rumana Akter, pursuant to Quality Bulletin ECHO-QAB-2026-11B, your order ORD-2026-1020 has been pre-shipment intercepted… swapped your unit to the certified clean B-501 replacement batch and upgraded your shipping to Expedited free of charge, while preserving your existing promotional discount."*

**Turn 3 — `EXECUTED`:** 4 rows updated, 4 emails recorded. SQL check after commit:

| Order | Batch | Tier | Status | Promo |
|---|---|---|---|---|
| ORD-2026-1012 | B-404 | Standard | Shipped (excluded ✅) | 0 |
| ORD-2026-1015 | **B-501** | **Expedited** | Ready for Expedited Dispatch | 0 |
| ORD-2026-1016 | B-409 | Standard | Delivered (excluded ✅) | 0 |
| ORD-2026-1017 | **B-501** | **Expedited** | Ready for Expedited Dispatch | 0 |
| ORD-2026-1018 | **B-501** | **Expedited** | Ready for Expedited Dispatch | 10 |
| ORD-2026-1019 | B-401 | Standard | Processing (clean batch, excluded ✅) | 0 |
| ORD-2026-1020 | **B-501** | **Expedited** | Ready for Expedited Dispatch | 15 |

### Scenario 2 — Manifest Reconciliation Across 2 Tables (Workspace 2)

**Prompt:** *"Reconcile the newly arrived inventory in the Port Receiving Manifest against open backorders in backorders_dataset.csv and update remaining available stock in products.csv according to our Allocation Priority Policy, then notify affected backorder buyers by email."*

**Turn 1 — `CLARIFICATION_REQUIRED`** (workflow `ed220230-c579-41f0-9a15-3515ed98bfb4`)
- Pool: 64 units (24 storefront + 40 arrived) vs. 60 backordered units plus a 10-unit buffer.
- 7 affected rows: 6 `VL-POLO-BLK` backorders and the product "Classic Short-Sleeve Polo".
- Options:
  - `option_1`: Clear all backorders first, leaving 4 units in the storefront.
  - `option_2`: Keep the 10-unit buffer and allocate 54 units by FIFO (selected).
- Citations: `Allocation Priority Policy.pdf`, `Port Receiving Manifest.pdf`, tables **`backorders_dataset` and `products`**.

**Turn 2 — `PREVIEW_READY`** (7 mutations across 2 tables)

| Table | Row | Before | After |
|---|---|---|---|
| backorders_dataset | BO-2001 | 0 / Pending | 12 / Fulfilled |
| backorders_dataset | BO-2004 | 0 / Pending | 8 / Fulfilled |
| backorders_dataset | BO-2002 | 0 / Pending | 10 / Fulfilled |
| backorders_dataset | BO-2006 | 0 / Pending | 10 / Fulfilled |
| backorders_dataset | BO-2009 | 0 / Pending | 12 / Fulfilled |
| backorders_dataset | BO-2013 | 0 / Pending | 2 / **Partial** |
| products | Classic Short-Sleeve Polo | `size` `{"M":4,"L":8,"XL":8,"XXL":4}` (24) | `{"M":2,"L":3,"XL":3,"XXL":2}` (**10**) |

- 54 units allocated + 10 kept as buffer = 64 ✅.
- 6 buyer emails: Sarah Jenkins, Lukas Lindqvist, Marcus Vance, Hannah Abbott, Kenji Takahashi, Daniel Kim (partial-fulfillment notice).

**Turn 3 — `EXECUTED`:** 7 rows committed across both tables in one transaction. SQL check: polo `size` sums to 10, and the 6 backorders match the table above. Other backorders (e.g. BO-2003, BO-2005, BO-2007) were untouched.

### Scenario 3 — Overdue Audit vs. Q4 VIP Retention (Workspace 3)

**Prompt:** *"Audit all wholesale accounts in wholesale_accunts_dataset.csv with overdue balances, enforce the required credit limit reductions and account holds per our Finance Credit Control Policy while factoring in Q4 VIP Expansion retention rules, and email the account contacts."*

**Turn 1 — `CLARIFICATION_REQUIRED`** (workflow `4a5af1eb-759d-4e4f-bbd5-f2c2a368b04d`)
- 5 affected rows: `ACC-1004, 1007, 1008, 1009, 1016`.
- 2 conflicting rows: `ACC-1004` (spend \$16,200) and `ACC-1007` (Gold).
- Options:
  - `option_1`: Strict policy on all 5 accounts.
  - `option_2`: VIP 14-day grace for 1004/1007; strict policy for the rest (selected).
- Citations: both PDFs and table `wholesale_accunts_dataset`.

**Turn 2 — `PREVIEW_READY`**

| Account | Manager | Before | After |
|---|---|---|---|
| ACC-1004 | David Chen | 10000 / Active | 10000 / **Retention Grace (14-Day)** |
| ACC-1007 | Tariq Al-Mansoor | 25000 / Active | 25000 / **Retention Grace (14-Day)** |
| ACC-1008 | Chloe Bennett | 3500 / Active | **2625 / Credit Hold** |
| ACC-1009 | Priya Nair | 7200 / Active | **5400 / Credit Hold** |
| ACC-1016 | Nathan Brooks | 2500 / Active | **1875 / Credit Hold** |

- 5 emails, each tailored: 2 retention-grace notices and 3 Credit Hold notices.

**Turn 3 — `EXECUTED`:** 5 rows updated. SQL check matches the table above. `ACC-1001` (no overdue balance) is unchanged at 8000 / Active.

## 5. Final State & Notes

- **Database left at clean baseline:** after its SQL checks, the suite re-uploads the baseline CSVs (`RESTORE_BASELINE=true` by default). All 3 workspaces are therefore back at baseline rows with the enriched PDFs indexed, ready for you to test in the UI.
- **Option coverage:** each run tested one option per scenario (S1 Option 1, S2 Option 2, S3 Option 2). The other options were offered correctly but not executed.
- **Known quirk:** in Scenario 2, Turn 1 reports `conflicting_rows_count = 7` (all affected rows). The buffer deficit really does involve all 7 rows, and it did not affect Turn 2 or Turn 3.
- **`test:scenarios` was not re-run:** the older 4-scenario suite was not run this session. It overwrites Veloura Apparel's documents and contains a Part 2A assertion that assumed `orders` had no batch column, which is no longer true after the enrichment. Running it would also require re-running `test:three-new` afterwards to restore state.
