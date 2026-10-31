# MaxiText AI Studio — Comprehensive User Manual

Welcome to **MaxiText AI Studio**, an intelligent customer engagement, AI support automation, and universal tabular inventory management platform. This manual walks you through the operational workflows of both customer-facing and company-facing interfaces, AI auto-reply suggestions, natural-language announcements, and universal multi-business spreadsheet management.

---

## Table of Contents
1. [Architecture & System Overview](#1-architecture--system-overview)
2. [Customer Portal Guide (`/customer`)](#2-customer-portal-guide-customer)
   - [Customer Registration & The One-Time Customer ID](#a-customer-registration--the-one-time-customer-id)
   - [Why the Customer ID Must Be Saved](#b-why-the-customer-id-must-be-saved)
   - [Logging into an Existing Chat Session](#c-logging-into-an-existing-chat-session)
   - [Customer Support Chat Knowledge Scope & Demo Inquiries](#d-customer-support-chat-knowledge-scope--demo-inquiries)
3. [Company Inquiry Dashboard Guide (`/company`)](#3-company-inquiry-dashboard-guide-company)
   - [Customer Conversation Management](#a-customer-conversation-management)
   - [AI-Generated Auto-Reply Suggestions (Copilot)](#b-ai-generated-auto-reply-suggestions-copilot)
   - [Editing vs. Directly Sending AI Suggestions](#c-editing-vs-directly-sending-ai-suggestions)
   - [Natural-Language Announcement Broadcasts](#d-natural-language-announcement-broadcasts)
4. [Universal Sheet Management & Manipulation Guide](#4-universal-sheet-management--manipulation-guide)
   - [Query vs. Mutation Workflows](#a-query-vs-mutation-workflows)
   - [Universal Multi-Business Inventory Management](#b-universal-multi-business-inventory-management)
   - [Dynamic Column Introspection & Dynamic Row Addition](#c-dynamic-column-introspection--dynamic-row-addition)
   - [Generalized Demo Commands (Multi-Industry)](#d-generalized-demo-commands-multi-industry)
5. [Troubleshooting & Best Practices](#5-troubleshooting--best-practices)

---

## 1. Architecture & System Overview

MaxiText AI Studio consists of two interconnected workspaces:
1. **Customer Portal (`http://localhost:5173/customer`)**: A streamlined customer interface for submitting inquiries, receiving AI-assisted or agent-reviewed answers, and retrieving persistent message history.
2. **Company Workspace (`http://localhost:5173/company`)**: A unified command center for support agents and business managers, featuring:
   - **Customer Inquiry Panel**: Real-time conversation inbox, message history, and Google Gemini-powered response drafts.
   - **Announcement Center**: Natural-language recipient filtering and bulk email broadcasts with live delivery tracking.
   - **Universal Sheet Management**: A live spreadsheet editor with natural-language SQL queries, staged two-phase mutations with side-by-side diff previews, and dynamic schema introspection for any business inventory.

```
                           ┌────────────────────────────────────────┐
                           │         MaxiText AI Studio UI          │
                           └──────────────────┬─────────────────────┘
                                              │
                     ┌────────────────────────┴────────────────────────┐
                     │                                                 │
          ┌──────────▼──────────┐                           ┌──────────▼──────────┐
          │   Customer Portal   │                           │  Company Dashboard  │
          │     (/customer)     │                           │      (/company)     │
          └──────────┬──────────┘                           └──────────┬──────────┘
                     │                                                 │
                     └────────────────────────┬────────────────────────┘
                                              │ REST API (JSON)
                                   ┌──────────▼──────────┐
                                   │  Node.js / Express  │
                                   │    Backend Engine   │
                                   └──────────┬──────────┘
                                              │
                 ┌────────────────────────────┼────────────────────────────┐
                 │                            │                            │
      ┌──────────▼──────────┐      ┌──────────▼──────────┐      ┌──────────▼──────────┐
      │  PostgreSQL (Relational│    │ Google Gemini API   │      │ Nodemailer SMTP     │
      │  Tables & Schemas)  │      │ (LLM & Suggestions) │      │ (Email Dispatch)    │
      └─────────────────────┘      └─────────────────────┘      └─────────────────────┘
```

---

## 2. Customer Portal Guide (`/customer`)

### A. Customer Registration & The One-Time Customer ID
To start a conversation with the support assistant, customers first register their identity:
1. Navigate to **`http://localhost:5173/customer`**.
2. Under **New Customer Registration**, enter:
   - **Customer Name**: Your full name (e.g., `Alex Rivera`).
   - **Email Address**: A valid email address (e.g., `alex.rivera@example.com`).
   - **External Customer ID** *(Optional)*: An external reference ID (omitted if left empty).
3. Click **Create Customer ID**.
4. A security popup will immediately appear displaying your newly generated **Customer ID (UUID)**:
   - Example: `f47ac10b-58cc-4372-a567-0e02b2c3d479`
   - Click the **Copy ID** button to copy the UUID to your clipboard.
   - The system automatically mirrors this ID in your browser's `localStorage` for session convenience.
   - Click **I Have Saved My Customer ID — Continue to Conversation** to enter the chat interface.

### B. Why the Customer ID Must Be Saved
> [!IMPORTANT]
> **Your Customer ID is only revealed once upon registration.**
> - **Privacy & Identity Security**: To prevent unauthorized users from harvesting or probing customer records by simply re-entering an email address, the backend **never discloses** an existing Customer ID if a registered email is submitted again (`409 Conflict`).
> - **Conversation Recovery**: Your Customer ID acts as your private cryptographic access key. Without it, you cannot retrieve your historical support threads, order inquiries, or pending agent replies.
> - **Workspace Scoping**: Every conversation is securely bound to the registered customer ID within the active business workspace (`684a8863-5094-4c8b-9b15-c50c06335b7f`).

### C. Logging into an Existing Chat Session
If you reload the page, switch devices, or return for a new inquiry:
1. Navigate to **`http://localhost:5173/customer`**.
2. In the **Continue with Existing Customer ID** card:
   - **Option 1 (One-Click Resume)**: If you are on the same browser where you registered, click **Resume Saved Browser Session**. The portal immediately reads your stored ID from `localStorage` and loads your thread.
   - **Option 2 (Manual ID Entry)**: Paste your saved Customer ID UUID into the input field and click **Continue with Customer ID**.
3. The portal validates your ID against the backend database, authenticates your session against the business, and displays your persistent conversation history.
4. If you need to switch accounts, click **Switch Customer** in the portal header at any time.

### D. Customer Support Chat Knowledge Scope & Demo Inquiries
The automated customer support engine is pre-grounded in structured domain knowledge:
- **`customer.csv`**: Customer registration records, identities, and contact metadata.
- **Base `products.csv`**: The **Veloura Luxury Apparel** catalog, which contains:
  - Product names (e.g., *Classic White Polo Shirt*, *Oxford Cotton Shirt*, *Luxury Linen Shirt*, *Casual Denim Shirt*).
  - Apparel categories (*Luxury Shirts*, *Casual Wear*, *Summer Collection*).
  - Detailed pricing, percentage discounts, and final calculated prices.
  - Color palettes (*White*, *Black*, *Navy Blue*, *Olive Green*, *Sky Blue*).
  - Available sizing (*S, M, L, XL, XXL, XXXL*).
  - Bestseller tags (`best = true/false`) and inventory order metrics.
  - Store logistics: Business hours (9 AM – 6 PM), 30-day return policy, and domestic shipping timelines.

#### Sample Demo Texts Customers Can Send:
Try sending any of the following inquiries into the customer chat box to test the support assistant's knowledge base:

| Inquiry Category | Demo Customer Message | Expected Assistant Response |
| :--- | :--- | :--- |
| **Bestsellers & Recommendations** | *"Which shirts are currently your top bestsellers?"* | Identifies products with `best = true` (e.g., Classic White Polo, Oxford Cotton Shirt) and highlights their features. |
| **Pricing & Discounts** | *"How much is the Classic White Polo Shirt with the current discount applied?"* | Computes final price based on base price ($1,850) minus discount (15% = $1,572.50). |
| **Color & Size Availability** | *"Do you have any luxury shirts available in Black in size XXL or XXXL?"* | Scans catalog attributes and returns matching items with confirmed sizing. |
| **Store Return Policy** | *"What is your return policy if a shirt doesn't fit properly?"* | Details the 30-day return window, requirement for original tags, and exchange procedure. |
| **Category Filtering** | *"Can you show me all items under the Summer Collection priced below $1,500?"* | Filters items by category and price constraints from `products.csv`. |
| **Shipping Timelines** | *"How long does standard domestic delivery take and what are your operating hours?"* | Explains standard 3–5 business day delivery and business support hours. |

---

## 3. Company Inquiry Dashboard Guide (`/company`)

Navigate to **`http://localhost:5173/company`** to access the company command dashboard.

### A. Customer Conversation Management
- **Unified Inbox**: The left panel lists all customer conversations in real-time, showing customer name, avatar, timestamp, and unread notification badges.
- **Unread Filter**: Click the **Mail** icon in the inbox header to toggle between unread conversations and the full conversation history.
- **Active Thread View**: Clicking a conversation opens the chronological message thread, distinguishing customer messages (gray bubbles) from agent replies (indigo bubbles).

### B. AI-Generated Auto-Reply Suggestions (Copilot)
When a customer sends an inquiry, the backend invokes Google Gemini with the verified context from `products.csv` and previous conversation history to synthesize a contextual reply draft.
- The generated draft appears in the **AI Workspace Copilot** panel on the right.
- The card displays an **AI Suggestion** badge, the customer's question, and the proposed answer.

### C. Editing vs. Directly Sending AI Suggestions
The support agent retains 100% control over every outbound communication:
1. **Send AI Suggestion Directly**: Click **Send Approved AI Suggestion** to immediately transmit the proposed response to the customer.
2. **Edit and Personalize**: Click directly inside the editable draft textarea in the Copilot card. You can adjust the tone, add specific order details, or include a custom coupon code. Once edited, click **Send Approved AI Suggestion** — the modified message is sent, and the conversation thread updates instantly.
3. **Manual Composer Reply**: Alternatively, you can disregard the suggestion and compose an independent response in the bottom reply bar.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AI Workspace Copilot Draft                      │
├────────────────────────────────────────────────────────────────────────┤
│ "Hello Alex! Our Classic White Polo Shirt is currently on sale for     │
│ $1,572.50 (15% off the original $1,850 price). We have sizes M, L,     │
│ and XL currently in stock. Would you like me to reserve one for you?"  │
├────────────────────────────────────────────────────────────────────────┤
│ [ ✏️ Edit Text Directly Above ]    [ 🚀 Send Approved AI Suggestion ] │
└────────────────────────────────────────────────────────────────────────┘
```

### D. Natural-Language Announcement Broadcasts
The Announcement system allows business managers to broadcast targeted emails to customer segments using simple English instructions:
1. In the Company Inquiry Panel header, click **Announcement History** or use the **AI Announcement Broadcast** widget.
2. Enter an audience targeting instruction into the prompt field, for example:
   - *"Send an announcement about a flat 20% weekend flash sale on all luxury shirts to users who registered after 2026-01-01."*
   - *"Broadcast an invitation to our VIP loyalty program to all registered customers."*
3. Click **Generate Announcement Draft**:
   - The NLP engine parses the instruction into **Audience Criteria** (e.g. `created_at > '2026-01-01'`) and **Message Body**.
   - The system queries the customer database, counts matching recipients, and generates a personalized email draft featuring `{{customer_name}}` merge tags.
4. **Review & Confirm**:
   - The modal displays the exact recipient count (e.g. `Targeted Audience: 12 customer(s)`).
   - If the audience criteria are ambiguous, the system requests clarification rather than sending to unintended recipients.
5. **Send**:
   - Click **Confirm & Send Broadcast**. The backend dispatches individual emails via Nodemailer SMTP.
   - A real-time delivery report breaks down successful deliveries, failed deliveries, and recipient error logs.
6. Click **Announcement History** at any time to review past broadcasts, dates, sent subjects, and confirmed recipient tallies.

---

## 4. Universal Sheet Management & Manipulation Guide

Click the **2. Sheet Management** tab in the company dashboard to open the **Universal Live Spreadsheet**.

### A. Query vs. Mutation Workflows
The AI Workspace Copilot supports two distinct operational modes:

| Operation Mode | Action Button | Database Effect | Visual Feedback |
| :--- | :--- | :--- | :--- |
| **Query Sheet** | **Query Sheet** | **Read-Only (None)** | Highlights matching rows with an indigo `MATCH` badge. Displays matched count (e.g. `Matched: 4 of 15 rows`). Full sheet remains visible. Click **Clear Row Highlights** to reset. |
| **Preview Mutation** | **Preview Mutation** | **Staged (No commit)** | Generates a structured mutation proposal. Opens a side-by-side **Before vs After Diff Table** detailing current vs. proposed values and affected row count. |
| **Apply Mutation** | **Confirm & Apply to Database** | **Committed (Atomic)** | Executes an atomic SQL transaction updating the PostgreSQL table. Persists across reloads. |

```
                       Natural-Language Mutation Flow
                       
   [ Enter NL Instruction ] ──► [ Click "Preview Mutation" ]
                                             │
                                             ▼
                             ┌───────────────────────────────┐
                             │  Side-by-Side Diff Table      │
                             │  • Affected Rows: 3           │
                             │  • Old Price ──► New Price    │
                             │  • Old Discount ──► New Disc. │
                             └───────────────┬───────────────┘
                                             │
                     ┌───────────────────────┴───────────────────────┐
                     │                                               │
             [ Click "Discard" ]                     [ Click "Confirm & Apply" ]
                     │                                               │
             Reverts preview;                               Executes atomic SQL;
             No changes committed.                          Updates database table.
```

### B. Universal Multi-Business Inventory Management
Unlike traditional spreadsheet tools tied to a single static schema, MaxiText AI Studio is **schema-agnostic**:
- **Dynamic Entity Switching**: The system supports arbitrary inventory tables (`products`, `electronics_inventory`, `shoe_inventory`, `grocery_inventory`, `auto_parts`).
- **Dynamic CSV Ingestion**: Click **Upload CSV** to upload any valid CSV file. The backend parses headers, maps types, and creates or replaces records dynamically.
- **Multi-Tenant Column Adaptation**: The AI prompt engineer dynamically retrieves the active table's exact column headers (`information_schema.columns`) and injects them into the Gemini prompt. Natural language instructions seamlessly adapt to whatever columns exist in the active sheet.

### C. Dynamic Column Introspection & Dynamic Row Addition
When you click **Add Row**:
1. The system inspects the active sheet table and retrieves all column keys (excluding auto-generated system fields like `id` and timestamps).
2. A responsive **Add New Row** modal dynamically renders appropriate form input fields for every column in the active table.
   - For example, if `shoe_inventory` is active, fields will be `product_name`, `brand`, `shoe_size`, `color`, `price`, `stock`.
   - If `grocery_inventory` is active, fields will be `item_name`, `supplier`, `category`, `unit_cost`, `expiry_date`.
3. Fill in the fields and click **Insert Row into Active Sheet**. The row is validated, saved to the database, and appended to the live spreadsheet view.

### D. Generalized Demo Commands (Multi-Industry)
You are not restricted to apparel! The following generalized natural-language commands work seamlessly across diverse business datasets:

#### 1. Tech & Electronics Inventory (`electronics_inventory`)
*Columns: `device_name, brand, category, ram_gb, storage_gb, price, stock_qty, warehouse, warranty_years`*
- **Read Queries**:
  - `"Show all laptops with 16GB RAM and price below $1200 located in Warehouse East."`
  - `"Find all wireless accessories with stock_qty less than 15 and warranty_years of 2."`
  - `"Show products manufactured by Dell or Lenovo with price greater than $800."`
- **Mutations (Preview & Apply)**:
  - `"Increase price by 8% for all laptops where brand is Apple."`
  - `"Reduce price of all monitors in Warehouse South by $50."`
  - `"Set warranty_years to 3 for all enterprise servers with price above $2000."`

#### 2. Footwear & Athletic Apparel (`shoe_inventory`)
*Columns: `shoe_name, brand, gender, size, color, price, discount_pct, in_stock, units_sold`*
- **Read Queries**:
  - `"Show all running shoes in color Black or Red available in size 10 with price under $120."`
  - `"Filter waterproof hiking shoes where in_stock is true and discount_pct is greater than 10."`
  - `"List all footwear with units_sold greater than 50."`
- **Mutations (Preview & Apply)**:
  - `"Apply a 15% discount to all winter boots with units_sold less than 5."`
  - `"Increase price by $10 for all running shoes where brand is Nike."`
  - `"Set in_stock to false for all shoe models where units_sold is 0."`

#### 3. Supermarket & Grocery Logistics (`grocery_inventory`)
*Columns: `item_name, category, supplier, unit_cost, current_price, stock_units, expiry_date, organic`*
- **Read Queries**:
  - `"List all organic dairy items with stock_units greater than 30."`
  - `"Show perishable products with expiry_date before 2026-12-31 and unit_cost under $5."`
  - `"Find all items supplied by 'GreenFields Farm' with current_price above $8."`
- **Mutations (Preview & Apply)**:
  - `"Reduce current_price by 12% for all bakery items with stock_units above 40."`
  - `"Increase unit_cost by $0.50 for all imported goods supplied by GlobalTrade."`
  - `"Set organic to true for all produce where supplier is 'EcoHarvest'."`

#### 4. Vehicle & Spare Parts Inventory (`auto_parts`)
*Columns: `part_name, part_number, vehicle_model, category, unit_price, quantity_on_hand, reorder_level`*
- **Read Queries**:
  - `"Show all brake components where quantity_on_hand is less than reorder_level."`
  - `"Find parts compatible with vehicle_model 'Sedan 2024' with unit_price under $150."`
- **Mutations (Preview & Apply)**:
  - `"Increase reorder_level by 5 for all transmission parts."`
  - `"Apply a 5% price increase across all parts where quantity_on_hand is below 10."`

---

## 5. Troubleshooting & Best Practices

| Symptom / Question | Root Cause | Solution |
| :--- | :--- | :--- |
| **"Customer ID is invalid for this business"** | Attempting to access customer portal with an ID belonging to another business. | Clear browser `localStorage` or register a new customer ID under the active business. |
| **"Email already registered" banner** | Attempting to register an existing email. | As a security safeguard, the ID is not re-displayed. Paste your previously saved Customer ID or click **Resume Saved Browser Session**. |
| **Backend Offline indicator in header** | Node.js backend on port 3000 is not running or unreachable. | Verify terminal running `cd backend && npm run dev`. Ensure health check returns `200` at `http://localhost:3000/api/health`. |
| **Table overflowing on mobile screens** | Viewing dense multi-column spreadsheet on small smartphone screen. | Swipe horizontally across the table! The table container features hardware-accelerated touch scrolling along the X-axis and sticky column headers. |
| **Announcement emails not delivering** | SMTP credentials not configured in `backend/.env`. | Verify `SMTP_USER` and `SMTP_PASS` (Gmail App Password) in `backend/.env`. If testing locally, set `SMTP_TEST_MODE=true` to simulate delivery. |

---

*MaxiText AI Studio — Developed with React 18, Redux Toolkit, Framer Motion, Express, PostgreSQL, and Google Gemini API.*
