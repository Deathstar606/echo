# Universal Business Inventory Editor — User Manual

This manual documents the architecture, dynamic schema discovery, natural-language query and mutation interpreter, API endpoints, semantic inventory conventions, and transactional safeguards of the **Universal Business Inventory Editor** in the Echo backend.

The system is fully generalized to understand and manipulate arbitrary business inventory sheets with distinct column names, structures, and data types without relying on a fixed products schema.

---

## 1. System Overview & Architecture

The Universal Business Inventory Editor converts free-form natural language instructions into validated, parameterized PostgreSQL queries and transactional mutations for any active business inventory table:

```
User Request (NL Message)
       │
       ▼
Dynamic Schema Discovery (discoverTableSchema)
  • Column names & PostgreSQL data types
  • Read-only vs. modifiable fields
  • Representative values & distinct categories
       │
       ▼
Gemini Universal Interpreter (buildSheetQueryPrompt)
  • Injected ACTIVE TABLE SCHEMA context block
  • Domain semantic mapping (Selling Price vs. Cost, Stock, Brand, Supplier, etc.)
  • Outputs structured JSON mutation plan or "clarification_needed"
       │
       ▼
Schema & Constraint Validation (validateMutation / validateFilter)
  • Case-insensitive column matching
  • Type coercion & numeric bound enforcement
       │
       ▼
Two-Stage Mutation Pipeline (sheetMutationService)
  • If confirm = false: previewMutation generates before/after diffs & SHA-256 preview_hash
  • If confirm = true: executeMutation acquires row locks (SELECT ... FOR UPDATE),
    executes parameterized SQL arithmetic in a PostgreSQL transaction, and commits
```

---

## 2. Dynamic Schema Discovery (`sheetSchemaService.js`)

Before generating a Gemini prompt or executing an operation, the backend inspects the active sheet selected by the user:

1. **Table Introspection**:
   - Queries PostgreSQL's `information_schema.columns` for `column_name`, `data_type`, and nullability.
   - Maps database types (`varchar`, `text`, `numeric`, `integer`, `boolean`, `date`, `uuid`) to internal normalized types (`string`, `number`, `integer`, `boolean`, `date`, `uuid`).
2. **Writable vs. System Fields**:
   - Primary key (`id`), tenant isolation (`business_id`), and audit timestamps (`created_at`, `updated_at`) are classified as `readonly: true` / `modifiable: false`.
   - Domain inventory fields are marked `modifiable: true` and `queryable: true`.
3. **Representative Value Sampling**:
   - Samples rows from the active table (`SELECT * FROM <table> WHERE business_id = $1 LIMIT 15`) to gather distinct non-null values for categorical columns (e.g. `Warehouse: Dhaka, Chittagong`, `Brand_Name: Asus, Dell, HP`, `Supplier: Acme, NorthStar`).
4. **Injection into LLM Context**:
   - On every query and mutation request, an `ACTIVE TABLE SCHEMA` block is dynamically injected into the prompt:
     ```text
     ACTIVE TABLE SCHEMA
     Table: electronics_inventory

     Available columns:
     - Product_Name (string)
     - Brand_Name (string)
     - Model (string)
     - Current_Price (number)
     - Stock_Qty (integer)
     - Warehouse (string)
     - Reorder_Level (integer)
     - Warranty_Months (integer)

     Representative values:
     - Warehouse: Dhaka, Chittagong
     - Brand_Name: Asus, Dell, HP, Lenovo
     ```

---

## 3. Universal Semantic Inventory Mapping

The interpreter recognizes general inventory concepts dynamically regardless of how individual columns are named:

| Inventory Concept | Common Column Variations | Semantic Behavior & Rules |
| :--- | :--- | :--- |
| **Product / Item Name** | `name`, `Product_Name`, `item_name`, `title` | Text identifying the item. Resolved case-insensitively and partial-name aware. |
| **Brand / Manufacturer** | `brand`, `Brand_Name`, `manufacturer`, `make` | Manufacturer or brand filter/update. |
| **Supplier / Distributor** | `supplier`, `Supplier`, `vendor`, `distributor` | Source entity supplying the product. |
| **Selling Price** | `price`, `Selling_Price`, `Current_Price`, `retail_price` | Customer-facing price. Targeted when user asks to discount, change price, or put on sale. |
| **Purchase / Unit Cost** | `cost`, `Unit_Cost`, `purchase_price`, `wholesale_price` | **CRITICAL BUSINESS RULE**: Never modified when user asks to discount or adjust price, unless user explicitly mentions *"cost"* or *"unit cost"*. |
| **Inventory Quantity / Stock** | `stock`, `Stock_Qty`, `Quantity`, `qty`, `inventory_count` | Available stock count. Supports integer addition, subtraction, and set. |
| **Reorder Threshold** | `reorder_level`, `Reorder_Level`, `restock_point`, `min_stock` | Threshold below which items need reordering. |
| **Storage Location** | `warehouse`, `Warehouse`, `Warehouse_Location`, `aisle`, `bin` | Storage facility or warehouse name. |
| **Category / Department** | `category`, `Department`, `type`, `group` | Classification group. |
| **Expiration Date** | `expiry_date`, `Expiry_Date`, `expiration`, `best_before` | Shelf life cutoff. Filterable by date comparisons (`<`, `>`, `between`). |
| **SKU / Identifier** | `sku`, `item_code`, `Batch_No`, `barcode` | Unique SKU or manufacturing batch code. |
| **Status Flags** | `best`, `status`, `Status`, `is_clearance`, `active` | Boolean or categorical status indicators (e.g. `'clearance'`, `'in_stock'`). |

### 3.1 Discount Conventions
- **Table with Explicit Discount Column** (e.g. `products`): Updating discount modifies the `discount` column using `percentage_points` (e.g. `20% + 5% = 25%`).
- **Table with Selling Price Column Only** (e.g. `electronics_inventory`): When user asks to *"Put a 10% discount on all products from Asus"*, the system reduces the selling price column (`Current_Price`) by 10% (`action: "subtract", value: 10, unit: "percentage"`).

### 3.2 Ambiguity Guardrails
- If a user asks to modify a field that does not exist in the active table (e.g. requesting a *"warranty"* change on `grocery_inventory`), the system returns `status: "clarification_needed"`.
- If required parameters (value, direction, or target) are missing, the system prompts for clarification instead of making arbitrary assumptions.

---

## 4. Multi-Schema Verification & 11 Core Demonstrations

The system was verified across three diverse inventory domains:

### Schema A: Apparel (`products` table)
Columns: `name`, `category`, `best`, `color`, `discount`, `ordered`, `images`, `size`, `price`

| # | Prompt | Operation | Filters | Updates |
| :--- | :--- | :--- | :--- | :--- |
| **1** | *"Increase the price of Stripe Shirt by $10."* | `update` | `name = 'Stripe Shirt'` | `price` add `10` (absolute) |
| **2** | *"Mark all summer shirts as best sellers."* | `update_many` | `category = 'summer shirt'` | `best` set `true` |
| **3** | *"Increase the stock of size XL by 3 for all black shirts."* | `update_many` | `color CONTAINS 'Black'` | `size.XL` add `3` (absolute) |

### Schema B: Electronics (`electronics_inventory` table)
Columns: `Product_Name`, `Brand_Name`, `Model`, `Current_Price`, `Stock_Qty`, `Warehouse`, `Reorder_Level`, `Warranty_Months`

| # | Prompt | Operation | Filters | Updates |
| :--- | :--- | :--- | :--- | :--- |
| **4** | *"Put a 10% discount on all products from Asus."* | `update_many` | `Brand_Name = 'Asus'` | `Current_Price` subtract `10` (percentage) |
| **5** | *"Increase the reorder level to 20 for products with less than 10 units in stock."* | `update_many` | `Stock_Qty < 10` | `Reorder_Level` set `20` (absolute) |
| **6** | *"Set the warranty period to 24 months for all Dell laptops."* | `update_many` | `Brand_Name = 'Dell'` AND `Model CONTAINS 'Laptop'` | `Warranty_Months` set `24` (absolute) |
| **7** | *"Increase the price of all products stored in Dhaka warehouse by 5%."* | `update_many` | `Warehouse = 'Dhaka'` | `Current_Price` add `5` (percentage) |

### Schema C: Grocery (`grocery_inventory` table)
Columns: `Item_Name`, `Supplier`, `Unit_Cost`, `Selling_Price`, `Expiry_Date`, `Batch_No`, `Quantity`, `Warehouse_Location`, `Status`

| # | Prompt | Operation | Filters | Updates |
| :--- | :--- | :--- | :--- | :--- |
| **8** | *"Reduce the selling price of products from supplier Acme by 50."* | `update_many` | `Supplier = 'Acme'` | `Selling_Price` subtract `50` (absolute). *(`Unit_Cost` untouched)* |
| **9** | *"Mark items expiring before January 1, 2027 as clearance."* | `update_many` | `Expiry_Date < '2027-01-01'` | `Status` set `'clearance'` |
| **10** | *"Increase the quantity of products in warehouse Dhaka by 15 units."* | `update_many` | `Warehouse_Location = 'Dhaka'` | `Quantity` add `15` (absolute) |
| **11** | *"Reduce the unit cost of products from supplier NorthStar by 5%."* | `update_many` | `Supplier = 'NorthStar'` | `Unit_Cost` subtract `5` (percentage). *(`Selling_Price` untouched)* |

---

## 5. API Reference

All endpoints accept a business identifier via URL parameter (`:businessId`), query string (`?businessId=...`), request body (`business_id`), or default to `684a8863-5094-4c8b-9b15-c50c06335b7f`.

### 5.1 Import Inventory CSV (Upload CSV & Add Rows)
- **Replace / Upload CSV**: `POST /api/sheets/:entity/upload` or `POST /api/sheets/upload`
  - **Content-Type**: `multipart/form-data` with key `file`
  - **Behavior**: Auto-detects table schema (apparel products, electronics inventory, grocery inventory, or dynamic schema). Atomically clears existing rows for that business in the table and imports valid CSV rows.
- **Add Rows (Append Mode)**: `POST /api/sheets/:entity/append` or `POST /api/sheets/append` (or `?mode=append`)
  - **Content-Type**: `multipart/form-data` with key `file`
  - **Behavior**: Strictly validates that uploaded CSV headers match the exact column names of the active sheet. Appends rows without deleting existing business records.
- **Response**:
  ```json
  {
    "message": "Successfully appended 3 row(s) to Electronics Inventory.",
    "business_id": "684a8863-5094-4c8b-9b15-c50c06335b7f",
    "entity": "electronics_inventory",
    "displayName": "Electronics Inventory",
    "source_file": "new_laptops.csv",
    "mode": "append",
    "total_rows": 3,
    "imported_count": 3,
    "rejected_count": 0,
    "errors": []
  }
  ```

### 5.2 List Sheet Rows
- **Endpoint**: `GET /api/sheets/:entity` or `GET /api/sheets/products`
- **Response**:
  ```json
  {
    "status": "ok",
    "entity": "electronics_inventory",
    "business_id": "684a8863-5094-4c8b-9b15-c50c06335b7f",
    "count": 6,
    "rows": [ ... ]
  }
  ```

### 5.3 Natural-Language Query
- **Endpoint**: `POST /api/sheets/query` (or `POST /api/sheets/:entity/query`)
- **Body**:
  ```json
  {
    "entity": "grocery_inventory",
    "message": "Show products from supplier Acme with selling price above 100"
  }
  ```
- **Response**:
  ```json
  {
    "status": "ok",
    "interpretedQuery": {
      "entity": "grocery_inventory",
      "operation": "filter",
      "filters": [
        { "field": "Supplier", "operator": "equals", "value": "Acme" },
        { "field": "Selling_Price", "operator": "greater_than", "value": 100 }
      ]
    },
    "rows": [ ... ],
    "count": 1
  }
  ```

### 5.4 Natural-Language Mutation (Preview & Confirm)
- **Endpoint**: `POST /api/sheets/mutate` (or `POST /api/sheets/:entity/mutate`)

#### Step 1: Preview (`confirm: false`)
```json
{
  "entity": "electronics_inventory",
  "message": "Put a 10% discount on all products from Asus.",
  "confirm": false
}
```
**Response**:
```json
{
  "status": "preview",
  "operation": "update_many",
  "entity": "electronics_inventory",
  "confirmation_required": true,
  "affected_count": 2,
  "preview_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "proposed_updates": [
    { "field": "Current_Price", "action": "subtract", "value": 10, "unit": "percentage" }
  ],
  "diff": [
    {
      "id": "22222222-2222-4222-8222-222222222221",
      "name": "ROG Strix G16",
      "before": { "Current_Price": 1350 },
      "after": { "Current_Price": 1215 }
    },
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "name": "Zenbook 14",
      "before": { "Current_Price": 1100 },
      "after": { "Current_Price": 990 }
    }
  ]
}
```

#### Step 2: Confirmation (`confirm: true`)
```json
{
  "entity": "electronics_inventory",
  "message": "Put a 10% discount on all products from Asus.",
  "confirm": true,
  "preview_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```
**Response**:
```json
{
  "status": "success",
  "operation": "update_many",
  "entity": "electronics_inventory",
  "affected_count": 2,
  "message": "Successfully updated 2 electronics_inventory record(s).",
  "updated_rows": [ ... ]
}
```

---

## 6. Safety & Integrity Safeguards

1. **Deterministic Preview Hash (`preview_hash`)**:
   - Computes a SHA-256 digest over the target rows and their before/after states. If any target row is modified between preview and confirmation, execution is rejected with HTTP 409 Conflict.
2. **Pessimistic Row Locking (`FOR UPDATE`)**:
   - Target rows are locked inside an explicit PostgreSQL transaction (`withTransaction`) before applying arithmetic updates, preventing concurrent race conditions.
3. **SQL Injection Prevention**:
   - LLMs are never permitted to generate raw SQL. All filtering and update clauses use parameterized placeholders (`$1, $2, ...`) and strictly validated column names.
4. **Post-Update Invariant Verification**:
   - Returned rows are checked to ensure no numerical field violates its schema boundaries (e.g. `Current_Price >= 0`, `Stock_Qty >= 0`, `discount` between 0 and 100).
