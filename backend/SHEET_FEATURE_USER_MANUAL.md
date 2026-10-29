# Natural-Language Spreadsheet Querying & Manipulation User Manual

This manual details the architecture, schema, endpoints, natural-language query capabilities, conditional bulk mutations, arithmetic transformations, nested size stock manipulation, and safety safeguards for the single-sheet `products` catalog (`backend/products.csv`) in the Echo backend.

---

## 1. Overview & Architecture

The natural-language spreadsheet pipeline converts free-form user instructions into validated, parameterized SQL operations on PostgreSQL:

```
User Request → Gemini JSON Plan → Schema & Constraint Validation → Preview (Diff + Hash) → User Confirmation → Transactional Execution
```

The system is organized into four core spreadsheet services plus context retrieval:
1. **`sheetSchemaService.js`**: Canonical schema definition for the single `products` table (`name`, `category`, `description`, `best`, `color`, `discount`, `ordered`, `images`, `size`, `price`), plus the virtual `total_stock` field and nested `size.<KEY>` stock fields (`size.M`, `size.L`, `size.XL`, `size.XXL`, `size.XXXL`). Enforces field whitelists, operator compatibility, arithmetic action rules, and numeric bounds.
2. **`sheetQueryPromptBuilder.js`**: Builds a compact, schema-aware prompt and normalizes the LLM's structured JSON output (`filter`, `update`, `update_many`, `delete`, `create`, or `clarification_needed`).
3. **`sheetQueryService.js`**: Builds and executes parameterized `SELECT` queries supporting `AND` / `OR` filter logic, comma-separated `color` matching, virtual `total_stock` summation across JSON `size` entries, and per-size `size.<KEY>` stock filtering.
4. **`sheetMutationService.js`**: Implements two-stage mutations (`previewMutation` when `confirm: false` and `executeMutation` when `confirm: true`) with per-row arithmetic preview, deterministic `preview_hash` verification, row-level `SELECT ... FOR UPDATE` locking, database-side SQL arithmetic, and transactional rollback on error.
5. **`contextRetrievalService.js`**: Grounds customer support inquiries directly in the live `products` table.

---

## 2. Supported Schema: `products` (`backend/products.csv`)

| Field | Type | Modifiable | Bounds / Allowed Values | Supported Filter Operators | Supported Update Actions |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `id` | UUID | No | Primary Key | `equals`, `not_equals`, `in` | Read-only |
| `business_id` | UUID | No | Scoped Business ID | System-enforced (`WHERE business_id = $1`) | Read-only |
| `name` | String | Yes | Non-empty string | `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `in` | `set` |
| `category` | String | Yes | Common: `shirt`, `polo`, `full shirt`, `luxury shirt`, `luxury polo`, `summer shirt` | `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `in` | `set` |
| `description` | Text | Yes | Product details, fabric, fit, sizing | `contains`, `not_contains`, `equals`, `not_equals` | `set` |
| `best` | Boolean | Yes | `true` or `false` | `equals`, `not_equals` | `set` |
| `color` | String | Yes | Comma-separated colors (e.g. `White, Black`) | `equals`, `not_equals`, `contains`, `not_contains`, `in` | `set` |
| `discount` | Numeric(5,2) | Yes | `0 <= discount <= 100` | `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `between` | `set`, `add`, `subtract`, `multiply` |
| `ordered` | Integer | Yes | `ordered >= 0` (integer) | `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `between` | `set`, `add`, `subtract`, `multiply` |
| `images` | Text | Yes | Image URLs or status text | `contains`, `not_contains`, `equals` | `set` |
| `size` | Text (JSON) | Yes | JSON map of size to stock (`{"M":2,"L":4,"XL":2,"XXL":2}`) | `equals`, `not_equals`, `contains`, `not_contains`, `in` | `set` |
| `size.<KEY>` | Integer (Nested) | Yes | `KEY` in `M`, `L`, `XL`, `XXL`, `XXXL`; value `>= 0` | `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `between` | `set`, `add`, `subtract`, `multiply` |
| `total_stock` | Integer (Virtual) | No | Sum of all size counts in `size` JSON (`>= 0`) | `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `between` | Filter-only |
| `price` | Numeric(10,2) | Yes | `price >= 0` | `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `between` | `set`, `add`, `subtract`, `multiply` |
| `created_at` | Timestamptz | No | ISO timestamp | `equals`, `greater_than`, `less_than`, `between`, `relative_days_ago`, `this_month` | Read-only |

---

## 3. Mutation JSON Contract & Percentage Semantics

### 3.1 Structured Mutation Plan (`update_many` / `update`)

```json
{
  "status": "ok",
  "message": "Reduce price by 200 for products with discount >= 25%",
  "entity": "products",
  "operation": "update_many",
  "filter_logic": "AND",
  "match_all": false,
  "target_filters": [
    {
      "field": "discount",
      "operator": "greater_than_or_equal",
      "value": 25
    }
  ],
  "updates": [
    {
      "field": "price",
      "action": "subtract",
      "value": 200,
      "unit": "absolute"
    }
  ]
}
```

- **Backward Compatibility**: Legacy single-record payloads using `"operation": "update"` and `"changes": { "price": 1450, "best": true }` continue to work and are automatically normalized into `updates`.
- **Targeting All Products**: When a bulk operation explicitly applies to every product in the catalog (e.g., *"Increase the stock of size M by 5 units for all products"*), `"match_all": true` with `"target_filters": []` is permitted. Unfiltered mutations without `"match_all": true` are rejected for safety.
- **Compound Filters (`AND` / `OR`)**: Multiple `target_filters` are combined with `AND` by default, or `OR` when `"filter_logic": "OR"` is specified (while always keeping `business_id = $1` enforced at the top level).

### 3.2 Arithmetic & Percentage Semantics

| User Intent / Phrasing | Field | Action | Value | Unit | Resulting Calculation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| *"Set the discount of products priced higher than 1500 to 10%."* | `discount` | `set` | `10` | `absolute` | `discount = 10` |
| *"Increase the discount of products currently discounted by less than 15% to 20%."* | `discount` | `set` | `20` | `absolute` | `discount = 20` (preposition *"to 20%"* sets target value) |
| *"Increase the discount of all summer shirts by 5%."* | `discount` | `add` | `5` | `percentage_points` | `discount = discount + 5` (e.g. `25 -> 30`) |
| *"Reduce the price of products with a discount of 25% or more by 200."* | `price` | `subtract` | `200` | `absolute` | `price = price - 200` |
| *"Increase the price of all luxury shirts by 10%."* | `price` | `add` | `10` | `percentage` | `price = ROUND(price * 1.10, 2)` |
| *"Increase the stock of size M by 5 units for all products."* | `size.M` | `add` | `5` | `absolute` | `size.M = COALESCE(size.M, 0) + 5` inside JSON `size` |
| *"Set the stock of size XL to zero for products priced above 1800."* | `size.XL` | `set` | `0` | `absolute` | `size.XL = 0` inside JSON `size` |

---

## 4. Supported Natural-Language Mutation Examples

1. **Conditional Boolean Flag Update**:
   - *"Set the best value of products ordered 2 times or more to true if it isn't already set."*
   - Filters `ordered >= 2` (and `best = false`), sets `best = true`.
2. **Price-Filtered Discount Assignment**:
   - *"Set the discount of products priced higher than 1500 to 10%."*
   - Filters `price > 1500`, sets `discount = 10`.
3. **Category-Filtered Percentage-Point Discount Increase**:
   - *"Increase the discount of all summer shirts by 5%."*
   - Filters `category = "summer shirt"`, adds `5` percentage points to `discount`.
4. **Discount-Filtered Absolute Price Reduction**:
   - *"Reduce the price of products with a discount of 25% or more by 200."*
   - Filters `discount >= 25`, subtracts `200` from `price`.
5. **Multi-Condition Category + Color Update**:
   - *"Set the discount of all white shirts to 15%."*
   - Filters `category = "shirt"` AND `color CONTAINS "White"`, sets `discount = 15`.
6. **Category-Wide Price Assignment**:
   - *"Set the price of all shirts to 1790."*
   - Filters `category = "shirt"`, sets `price = 1790`.
7. **Threshold-Filtered Target Discount Assignment**:
   - *"Increase the discount of products currently discounted by less than 15% to 20%."*
   - Filters `discount < 15`, sets `discount = 20`.
8. **Total Inventory (`total_stock`) Filtered Update**:
   - *"Set the best value to true for products with at least 15 units in total across all sizes."*
   - Filters `total_stock >= 15` (summed across all keys in `size` JSON), sets `best = true`.
9. **Catalog-Wide Nested Size Stock Addition**:
   - *"Increase the stock of size M by 5 units for all products."*
   - Sets `match_all: true`, adds `5` to `size.M` in each product's JSON `size` map (initializing `M` to `0 + 5 = 5` if `M` was absent).
10. **Conditional Nested Size Stock Reset**:
    - *"Set the stock of size XL to zero for products priced above 1800."*
    - Filters `price > 1800`, sets `size.XL = 0` in each matching product's JSON `size` map.

---

## 5. Two-Stage Preview & Confirmation Workflow

### Stage 1: Preview (`confirm: false`)
`POST /api/sheets/mutate` (or `POST /api/sheets/mutation` / `POST /api/businesses/:businessId/sheets/mutate`)

**Request Body**:
```json
{
  "entity": "products",
  "message": "Increase the discount of all summer shirts by 5%.",
  "confirm": false
}
```

**Response (`200 OK`)**:
- Does **not** modify the database.
- Resolves all matching rows for the business, computes the exact `before` and `after` values for every affected row, validates per-row constraints (e.g., ensuring `discount + 5 <= 100` and `price - 200 >= 0`), and returns:
  - `status`: `"preview"`
  - `affected_count`: number of matching rows
  - `preview_hash`: deterministic SHA-256 hash of the target row IDs and their `before`/`after` values
  - `diff`: array of `{ id, name, before, after, changes }`
  - `target_rows`: current matching rows

### Stage 2: Confirmed Execution (`confirm: true`)

**Request Body**:
```json
{
  "entity": "products",
  "message": "Increase the discount of all summer shirts by 5%.",
  "confirm": true,
  "preview_hash": "a1b2c3d4e5f60718"
}
```

**Response (`200 OK`)**:
- Runs inside a PostgreSQL transaction (`BEGIN` ... `SELECT ... FOR UPDATE` ... `UPDATE` ... `COMMIT`).
- If `preview_hash` (or `expected_preview_hash`) is supplied and the underlying rows changed since the preview was generated, rejects with `409 Conflict` so stale previews never overwrite newer data.
- Re-validates per-row constraints against the locked rows and executes parameterized SQL updates.
- Returns `status: "success"`, `affected_count`, `updated_rows`, and `diff`.

---

## 6. Ambiguity Handling, Common Errors & Limitations

1. **Ambiguous Requests or Missing Values (`200 OK` with `status: "clarification_needed"`)**:
   - Example: *"Update the discount of OpenWeave Shirt."* (missing target discount value).
   - Example: *"Find products by warehouse location."* (references a column that does not exist in `products.csv`).
2. **Constraint Violations (`400 Bad Request`)**:
   - Setting or computing `discount > 100` or `discount < 0`.
   - Setting or computing `price < 0`, `ordered < 0`, or `size.<KEY> < 0` (negative stock).
   - Attempting arithmetic (`add`, `subtract`, `multiply`) on non-numeric fields (`name`, `category`, `best`, `color`, `description`, `images`).
   - Using an unsupported size key outside `M, L, XL, XXL, XXXL`.
3. **Zero Matching Records (`200 OK` with `status: "not_found"`)**:
   - When valid filters match `0` products for the business, returns `status: "not_found"` and `affected_count: 0` without modifying any data.
4. **Stale Preview (`409 Conflict`)**:
   - Returned when `confirm: true` includes a `preview_hash` that no longer matches current database state.
5. **Known Limitations**:
   - Only the single `products` table (seeded from `backend/products.csv`) is supported.
   - Nested size stock operations support the standard apparel size keys (`M`, `L`, `XL`, `XXL`, `XXXL`).
   - Arithmetic operations update columns across rows independently; cross-row aggregations (such as setting a product's price equal to the average price of all products) are not supported.
