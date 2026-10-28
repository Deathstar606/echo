# MaxiText AI Studio Workspace — User Manual

This guide explains how to set up, start, and operate the **MaxiText AI Studio Workspace** frontend and its accompanying Node.js/PostgreSQL backend.

---

## 1. Prerequisites

### Backend Prerequisites
- **Node.js**: `v26.8.1` or higher (or Node 18+ with native `fetch` support)
- **npm**: Node package manager
- **PostgreSQL**: v13+ (local instance or cloud-hosted PostgreSQL such as Aiven/Supabase configured in `backend/.env`)
- **Environment Configuration (`backend/.env`)**:
  - `PORT=3000`
  - `HOST=localhost`
  - `DATABASE_URL=postgresql://...`
  - `GEMINI_API_KEY=...` (Google AI Studio API key for generating contextual support reply suggestions)

### Frontend Prerequisites
- **Node.js & npm**
- Modern web browser (Chrome, Edge, Firefox, or Safari)

---

## 2. Database Migration & Initialization

Before running the application for the first time (or after pulling updates), run the database initialization script from the `backend` directory. This applies `backend/db/schema.sql` and all migrations in `backend/db/migrations/` (including `004_conversation_ai_suggestions.sql`, which adds server-side AI draft columns to `conversations` and `messages` and seeds the default business `684a8863-5094-4c8b-9b15-c50c06335b7f`):

```bash
cd backend
npm install
npm run db:init
```

---

## 3. Installation & Startup Instructions

### Step 1: Start the Backend Server (`http://localhost:3000`)

Open a terminal in the `backend` folder:

```bash
cd backend
npm install
npm run dev
```

*(Or use `npm start` for production mode.)*
Verify the backend is running at `http://localhost:3000/api/health`.

### Step 2: Start the Frontend Dev Server (`http://localhost:5173`)

Open a second terminal in the `frontend` folder:

```bash
cd frontend
npm install
npm run dev
```

The Vite development server starts at **`http://localhost:5173`**.

---

## 4. Opening the Two Interfaces

The frontend provides two distinct interfaces (plus an optional launcher page at `/`) that can also be switched using the top header navigation bar or opened side-by-side in two browser tabs:

1. **Launcher / Overview**: `http://localhost:5173/`
2. **Customer Inquiry Panel**: `http://localhost:5173/customer`
3. **Company Inquiry & AI Workspace Panel**: `http://localhost:5173/company`

> **Hardcoded Business ID**: Every business-scoped request across both interfaces uses the shared `BUSINESS_ID` defined in `frontend/src/config/constants.js`:
> `684a8863-5094-4c8b-9b15-c50c06335b7f`

---

## 5. Operating the Customer Panel (`/customer`)

### A. Creating a New Customer ID & Saving It
1. Open `http://localhost:5173/customer`.
2. In the **New Customer Registration** card on the left, enter:
   - **Customer Name** *(required, e.g., `Alex Rivera`)*
   - **Email Address** *(required, e.g., `alex.rivera@example.com`)*
   - **External Customer ID** *(optional — automatically omitted from the request payload when left blank)*
3. Click **Create Customer ID**.
4. **One-Time Security Popup**:
   - Upon successful registration (`201 Created`), a modal popup displays your newly generated `customer_id` UUID.
   - Click **Copy ID** next to the UUID to copy it to your clipboard.
   - The ID is also automatically stored in your browser's `localStorage` (`maxitext_customer_id`).
   - **Important**: This ID is revealed **only once**. Once you click **I Have Saved My Customer ID — Continue to Conversation**, the popup closes and the raw UUID is never displayed again in the interface.
5. **Duplicate Email Handling**:
   - If you attempt to register with an email address that already exists for this business (`409 Conflict`), the backend and frontend never disclose the existing `customer_id`. Instead, a warning banner directs you to sign in using your previously saved Customer ID.

### B. Returning Using an Existing Customer ID
1. Open `http://localhost:5173/customer` (if you are already in an active session, click **Switch Customer** in the top-right of the portal).
2. In the **Continue with Existing Customer ID** card on the right:
   - Paste your saved `customer_id` UUID into **Your Saved Customer ID** and click **Continue with Customer ID**, *or*
   - Click **Resume Saved Browser Session** if your ID is already stored in `localStorage`.
3. The frontend validates your `customer_id` against `BUSINESS_ID` (`684a8863-5094-4c8b-9b15-c50c06335b7f`) via `POST /api/businesses/{BUSINESS_ID}/conversations/history`:
   - If an existing conversation is found, its full message history is loaded without creating a duplicate conversation.
   - If the customer is valid for this business but has no conversation yet, the frontend creates one automatically via `POST /api/businesses/{BUSINESS_ID}/conversations`.
   - For demonstration convenience, the verified customer **`Jane Smith`** (`jane.smith@maxitext.demo`) is pre-seeded under `BUSINESS_ID` with Customer ID: `c9fdc847-ed5d-43ca-8050-abc3c48431f8`.

### C. Testing a Customer Inquiry
1. Once inside the Customer Conversation view, type an inquiry in the bottom message bar (for example: *"Hello, can I get an extension on my overdue balance?"* or *"Can I reschedule my consultation appointment?"*) and click the **Send** button.
2. While the request is processing, a pending bubble (`Sending message...`) is shown and duplicate submissions are disabled.
3. Once confirmed, your message appears in the conversation history.
4. **Privacy Guarantee**: Even though the backend generates an AI-suggested draft reply when your message arrives, that AI suggestion is saved strictly server-side in PostgreSQL and is **never** included in the customer API response or displayed in the customer UI.

---

## 6. Operating the Company Inquiry Panel (`/company`)

1. Open `http://localhost:5173/company` (ensure tab **`1. [Active] Customer Inquiry`** is selected).
2. **Left Inbox Column**:
   - Lists all conversations belonging to `BUSINESS_ID`, ordered by latest activity.
   - Displays each customer's name, latest message preview, activity timestamp, and an unread badge (`1`, `2`, etc.) when incoming customer messages are awaiting a reply.
   - Use the **Envelope icon** at the top of the Inbox to filter unread inquiries, or the **Refresh icon** to manually refresh.
3. **Central Conversation Thread**:
   - Click any conversation in the Inbox to load its chronological message history.
   - Incoming customer messages appear on the left in gray speech bubbles; outgoing company replies appear on the right in royal-blue speech bubbles.
4. **Right-Hand Panel — `MaxiText AI Workspace Copilot`**:
   - When the selected conversation has an incoming customer inquiry, the **AI Suggested Reply (Draft)** card prominently displays:
     - The customer's original message for context
     - The AI classification category badge (e.g., `billing_policy`, `cancellation_policy`) and any missing-information notes
     - An editable textarea pre-filled with the AI-generated draft response
   - **Reviewing, Editing, and Sending a Reply**:
     - You can edit the AI suggestion directly in the Copilot textarea (and click **Restore Original** if you wish to revert your edits).
     - Click **Send Approved Response** in the Copilot panel to send the response directly to the customer, *or* click **To Reply Box** to copy the draft into the bottom thread input bar (`Type a message to reply...`) and press **Send**.
     - You can also type a completely custom response in the bottom reply bar at any time.
5. Once sent (`POST /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}/replies`), the reply immediately appears in the company conversation thread, clears the pending unread badge and AI draft, and automatically appears in the customer's conversation view (`/customer`).

---

## 7. Backend API Endpoints Used by the Frontend

All requests use base URL `http://localhost:3000` and `BUSINESS_ID = 684a8863-5094-4c8b-9b15-c50c06335b7f`:

| Interface | Method & Endpoint | Purpose |
| :--- | :--- | :--- |
| Shared Header | `GET /api/health` | Verifies backend connectivity status (`Connected to AI Studio API`) |
| Customer Panel | `POST /api/businesses/{BUSINESS_ID}/customers` | Registers a new customer and returns a one-time `customer_id` (`409` on duplicate email) |
| Customer Panel | `POST /api/businesses/{BUSINESS_ID}/conversations/history` | Validates `customer_id` against `BUSINESS_ID` and returns existing conversation + customer-safe messages |
| Customer Panel | `POST /api/businesses/{BUSINESS_ID}/conversations` | Creates a new conversation when a validated customer has none yet |
| Customer Panel | `POST /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}/messages` | Saves customer message, generates & stores AI suggestion server-side, returns **only** customer-safe message data |
| Company Panel | `GET /api/businesses/{BUSINESS_ID}/conversations` | Lists all conversations for `BUSINESS_ID` with customer metadata, unread counts, and AI drafts |
| Company Panel | `GET /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}` | Retrieves full chronological messages and active server-side AI suggestion for a specific conversation |
| Company Panel | `POST /api/businesses/{BUSINESS_ID}/conversations/{conversation_id}/replies` | Persists an approved/edited/manual company reply (`sender_type: 'agent'`) and clears the active AI draft |

---

## 8. Prototype Placeholder Panels

As specified for this implementation pass, the following sections are realistic visual placeholders and are explicitly labeled as **PROTOTYPE**, **BETA**, or **DEMO**:

1. **Announcement Box & Announcement History (Right Panel & Header Button in `/company`)**:
   - Reproduces the wireframe's recipient targeting toggle (`Some Customers` | `All Customers`), natural-language campaign prompt, live AI-generated preview box, and `Send Announcement` CTA button.
   - Clicking `Send Announcement` displays a clear prototype confirmation banner and never dispatches real bulk emails.
2. **Sheet Management Tab (`2. Sheet Management` in `/company`)**:
   - Demonstrates natural-language querying and two-phase modification previews (`Before` vs. `Proposed After`) using locally bundled demo datasets (`sample-products.csv` and `sample-services.csv`).
   - Does not claim Google Sheets API integration and never triggers unintended database mutations.
3. **Business Sign-In & Voice/Video Call Icons**:
   - `Sign in Business` opens a workspace identity modal displaying the active hardcoded `BUSINESS_ID`.
   - Phone and video icons in the conversation header display a non-intrusive prototype notice.

---

## 9. Known Limitations & Database Migration Notes

- **Database Migration (`004_conversation_ai_suggestions.sql`)**:
  - Adds `ai_draft_reply`, `ai_draft_category`, `ai_draft_missing_info`, `ai_draft_message_id`, and `ai_draft_updated_at` to `conversations`, plus `ai_suggestion`, `ai_category`, and `ai_missing_info` to `messages`.
  - Run `npm run db:init` inside `backend/` to ensure these columns exist.
- **Polling Interval**:
  - Both `/customer` and `/company` poll for conversation updates every 4 seconds in addition to immediate updates on form submission, plus manual **Refresh** buttons in both interfaces.
- **Single Active Business Scope**:
  - All operations are intentionally locked to `BUSINESS_ID = 684a8863-5094-4c8b-9b15-c50c06335b7f`. Customer IDs belonging to other businesses are rejected.
