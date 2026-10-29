# Natural-Language Spreadsheet Querying & Manipulation User Manual

This manual details the architecture, configuration, endpoints, natural-language query capabilities, and mutation safeguards for the single-sheet `products` catalog (`backend/products.csv`) in the Echo backend.

---

## 1. Overview & Architecture

The natural-language spreadsheet feature allows users and frontend interfaces to upload, view, query, and manipulate the `products` catalog using natural language, and automatically grounds customer support inquiries in the live `products` table.

The system is organized into four core spreadsheet services plus context retrieval:
1. **`sheetSchemaService.js`**: Canonical schema definition for the single `products` table (`name`, `category`, `description`, `best`, `color`, `discount`, `ordered`, `images`, `size`, `price`). Validates all requested columns, value types, and operators.
2. **`sheetQueryPromptBuilder.js`**: Transforms user natural-language queries and mutation instructions into structured JSON using Google AI Studio (Gemini).
3. **`sheetQueryService.js`**: Accepts validated JSON queries and executes safe parameterized SQL against PostgreSQL (`products` table), including smart matching on comma-separated `color` strings and JSON `size` stock maps.
4. **`sheetMutationService.js`**: Implements safe, two-phase data modifications (Stage 1 preview with `confirm: false`, Stage 2 confirmed execution with `confirm: true`) inside database transactions.
5. **`contextRetrievalService.js`**: Retrieves and ranks matching product records directly from the `products` table when customers send support inquiries.

---

## 2. Supported Schema: `products` (`backend/products.csv`)

| Column | Type | Nullable | Description | Allowed Query Operators |
| :--- | :--- | :--- | :--- | :--- |
| `id` | UUID | No | Primary Key | `equals` |
| `business_id`| UUID | No | Scoped Business ID | System-managed |
| `name` | String | No | Product title | `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `in` |
| `category` | String | Yes | Category (`shirt`, `polo`, `full shirt`, `luxury shirt`, `luxury polo`, `summer shirt`) | `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `in` |
| `description`| Text | Yes | Fabric, fit, care & sizing details | `contains`, `not_contains`, `equals`, `not_equals` |
| `best` | Boolean | No | Best-seller flag (`true` / `false`) | `equals`, `not_equals` |
| `color` | String | Yes | Comma-separated colors (e.g. `White, Black`) | `equals`, `not_equals`, `contains`, `not_contains`, `in` |
| `discount` | Numeric(5,2) | No | Percentage discount (`0` - `100`) | `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `between` |
| `ordered` | Integer | No | Number of orders placed (`>= 0`) | `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `between` |
| `images` | Text | Yes | Comma-separated image URLs | `contains`, `not_contains`, `equals` |
| `size` | Text (JSON) | Yes | JSON map of size to stock (e.g. `{"M":2,"L":4,"XL":2,"XXL":2}`) | `equals`, `not_equals`, `contains`, `not_contains`, `in` |
| `price` | Numeric(10,2) | No | Selling price (`>= 0`) | `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `between` |
| `created_at` | Timestamptz | No | Record creation timestamp | `equals`, `greater_than`, `less_than`, `between`, `relative_days_ago`, `this_month` |

---

## 3. Endpoints Reference

### 3.1 Upload Products CSV
- **URL**: `POST /api/sheets/products/upload` (or `POST /api/businesses/:businessId/sheets/products/upload`)
- **Body**: `multipart/form-data` with field key `file`
- **CSV Structure**: `name,category,description,best,color,discount,ordered,images,size,price`
- **Re-upload Behavior**: Replaces existing product rows for the business inside a transaction.

### 3.2 List Products Sheet
- **URL**: `GET /api/sheets/products?businessId=684a8863-5094-4c8b-9b15-c50c06335b7f`

### 3.3 Natural-Language Query Endpoint
- **URL**: `POST /api/sheets/query` (or `POST /api/businesses/:businessId/sheets/query`)
- **Body**: `{ "entity": "products", "message": "Show all best-selling products." }`

### 3.4 Two-Stage Mutation Endpoint
- **URL**: `POST /api/sheets/mutation` (or `POST /api/sheets/mutate`)
- **Stage 1 Preview**: `{ "entity": "products", "message": "Change the price of OpenWeave Shirt to 1450.", "confirm": false }`
- **Stage 2 Apply**: `{ "entity": "products", "message": "Change the price of OpenWeave Shirt to 1450.", "confirm": true }`
