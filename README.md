# MaxiText AI Studio

> **Enterprise-Grade AI Customer Engagement, Support Automation & Universal Tabular Inventory Management**

MaxiText AI Studio is a full-stack, AI-driven workspace prototype engineered to bridge customer support with enterprise tabular data. The platform combines real-time conversational customer support, Google Gemini-powered response synthesis, natural-language targeted email broadcasts, and an interactive, schema-agnostic live spreadsheet engine with staged two-phase mutations.

[![Tests](https://img.shields.io/badge/backend_tests-60%2F60_passing-16a34a.svg?style=flat-square)](file:///c:/Users/USER/Desktop/Development/Echo/backend/test)
[![Frontend](https://img.shields.io/badge/frontend-React_18_+_Redux_Toolkit-3946d3.svg?style=flat-square)](file:///c:/Users/USER/Desktop/Development/Echo/frontend)
[![Styling](https://img.shields.io/badge/UI-Liquid_Glass_+_Framer_Motion-7c3aed.svg?style=flat-square)](file:///c:/Users/USER/Desktop/Development/Echo/frontend/src/index.css)
[![Backend](https://img.shields.io/badge/backend-Node.js_+_Express_+_PostgreSQL-0ea5e9.svg?style=flat-square)](file:///c:/Users/USER/Desktop/Development/Echo/backend)
[![AI Engine](https://img.shields.io/badge/AI-Google_Gemini_API-f59e0b.svg?style=flat-square)](https://ai.google.dev/)

---

## 📑 Table of Contents
- [Key Features](#-key-features)
- [Architecture & Tech Stack](#-architecture--tech-stack)
- [Hardcoded Business ID & Production Roadmap](#-hardcoded-business-id--production-roadmap)
- [Announcement Broadcasts & Live Demo Email Notice](#-announcement-broadcasts--live-demo-email-notice)
- [Step-by-Step Installation & Setup](#-step-by-step-installation--setup)
- [Local vs. Hosted Backend Configuration](#-local-vs-hosted-backend-configuration)
- [Two Distinct Workspaces](#-two-distinct-workspaces)
- [Running Automated Tests](#-running-automated-tests)
- [User Documentation & Guides](#-user-documentation--guides)

---

## 🌟 Key Features

### 1. Customer Support & AI Auto-Reply Copilot
- **Secure Customer Registration**: Customers register with their name and email, receiving a one-time cryptographic Customer ID (UUID) that protects their identity and preserves complete chat history across sessions.
- **Persistent Conversational Threads**: Real-time customer chat interface powered by PostgreSQL and Redux state synchronization.
- **AI-Powered Response Synthesis**: Inbound customer inquiries trigger Google Gemini to synthesize context-aware draft suggestions based on conversation history and structured catalog knowledge (`products.csv`).
- **Human-in-the-Loop Agent Control**: Support agents can approve and dispatch AI suggestions with one click, modify the draft directly in an editable composer before sending, or write custom manual responses.

### 2. Natural-Language Announcement Engine
- **Plain-English Audience Filtering**: Send announcements to customer segments using intuitive criteria (e.g., *"Send a 20% discount on luxury polos to customers who registered after 2026-01-01"*).
- **Separation of Concerns**: Natural language processing extracts audience criteria independently from the announcement body, eliminating SQL injection risks and executing validated database queries.
- **Personalized Merge Tags**: Generates dynamic email templates featuring `{{customer_name}}` and preview summaries.
- **Live Delivery Auditing**: Sends individual emails via Nodemailer SMTP with delivery tracking, failure logs, and persistent Announcement History.

### 3. Universal Tabular Spreadsheet Management
- **Schema-Agnostic Inventory Engine**: Introspects relational table columns dynamically (`information_schema`), supporting arbitrary business inventories (apparel, electronics, automotive, groceries) with diverse keys.
- **Natural-Language Queries**: Ask plain-English questions (e.g., *"Show laptops in Warehouse Dhaka with stock under 15"*) to highlight matching rows with visual indicators without modifying data.
- **Staged Two-Phase Mutations**: Bulk arithmetic and categorical updates (e.g., *"Increase prices by 10% for items with stock below 20"*) generate side-by-side **Before vs. After Diff Previews** requiring explicit confirmation (`confirm: true`) within atomic database transactions.
- **Dynamic Row Addition**: Generates modal form inputs dynamically based on the exact columns of the active sheet.
- **Touch-Friendly & Mobile-Responsive**: Complete horizontal (X-axis) touch scrolling, sticky column headers, and responsive layout stacking.

### 4. Liquid Glass UI & Fluid Motion
- **Frosted Glassmorphism**: Translucent panels with background blurs, specular highlights, and hardware-accelerated rendering.
- **LayoutId Tab Glide Animations**: Framer Motion spring physics smoothly glide active tab indicators between workspace modes and header interfaces.

---

## 🏗 Architecture & Tech Stack

```
                               ┌────────────────────────────────────────────────┐
                               │           MaxiText AI Studio Frontend          │
                               │   React 18 • Redux Toolkit • Framer Motion    │
                               └───────────────────────┬────────────────────────┘
                                                       │
                           ┌───────────────────────────┴───────────────────────────┐
                           │                                                       │
                ┌──────────▼──────────┐                                 ┌──────────▼──────────┐
                │   Customer Portal   │                                 │  Company Dashboard  │
                │     (/customer)     │                                 │      (/company)     │
                └──────────┬──────────┘                                 └──────────┬──────────┘
                           │                                                       │
                           └───────────────────────────┬───────────────────────────┘
                                                       │ HTTP REST API (port 3000)
                                            ┌──────────▼──────────┐
                                            │  Express / Node.js  │
                                            │   Backend Service   │
                                            └──────────┬──────────┘
                                                       │
                        ┌──────────────────────────────┼──────────────────────────────┐
                        │                              │                              │
             ┌──────────▼──────────┐        ┌──────────▼──────────┐        ┌──────────▼──────────┐
             │     PostgreSQL      │        │  Google Gemini API  │        │   Nodemailer SMTP   │
             │ Relational Database │        │  (LLM Prompt Eng.)  │        │ (Bulk Announcement) │
             └─────────────────────┘        └─────────────────────┘        └─────────────────────┘
```

| Layer | Technologies | Key Highlights |
| :--- | :--- | :--- |
| **Frontend** | React 18, Redux Toolkit, Vite, Framer Motion, Lucide Icons | Responsive grid, liquid glass design, spring tab sliding, custom X-axis scrolling table |
| **Backend** | Node.js (v26.8+), Express, Helmet, Morgan, Multer | Parameterized safe SQL, transactional mutations, structured error handling |
| **Database** | PostgreSQL 13+ (Local or Managed Cloud like Aiven/Supabase) | Multi-table relational schema, dynamic introspection, index optimization |
| **AI Integration** | Google Gemini API (`@google/genai`) | Contextual customer support replies, natural-language SQL query and mutation compilation |
| **Email Service** | Nodemailer | Individual recipient delivery, HTML templating, personalized placeholder interpolation |

---

## 🔒 Hardcoded Business ID & Production Roadmap

In this demonstration prototype, all business-scoped frontend and backend API operations use a shared, pre-configured **Business ID**:

```text
684a8863-5094-4c8b-9b15-c50c06335b7f
```

### Why is the Business ID Hardcoded in the Prototype?
1. **Deterministic Workspace Isolation**: Guarantees that all customer accounts, conversation threads, uploaded sheets, and announcement broadcasts are strictly scoped to a single enterprise workspace without manual multi-tenant setup.
2. **Seamless Demonstration**: Enables prospective clients, developers, and evaluators to clone the repository and immediately experience customer inquiries, AI suggestions, and inventory spreadsheets without undergoing a tedious multi-step business onboarding wizard.
3. **Customer Privacy Protection**: Ensures customer records and conversation histories are permanently isolated from other tenants in the shared database.

### Production Roadmap:
In the forthcoming production release, this hardcoded identifier will be replaced with:
- **Dynamic Organization Provisioning**: Multi-tenant workspace creation during corporate onboarding.
- **JWT / OAuth2 Session Authentication**: Tenant ID resolved automatically from the authenticated agent's session claims.
- **Enterprise Workspace Switcher**: Multi-business management allowing managers to toggle between brand profiles (previewed in the prototype's **Sign in Business** modal).

---

## 📢 Announcement Broadcasts & Live Demo Email Notice

> [!IMPORTANT]
> **Announcement Bulk Email Delivery Notice (Live Demo Mode)**:
> The Announcement feature in MaxiText AI Studio is equipped with real-world email dispatch using **Nodemailer**. 
> - In this prototype, outgoing announcements are sent using a **personal demo Gmail account** via Google App Passwords.
> - When testing with real recipient emails, actual emails will be dispatched to customers registered in the database.
> - To test the complete targeting and drafting workflow **without sending external emails**, you can set `SMTP_TEST_MODE=true` in `backend/.env`. The backend will simulate successful transmission and return complete delivery statistics.

---

## 🚀 Step-by-Step Installation & Setup

Follow these steps to clone the repository, switch to the active development branch, and run the backend and frontend locally.

### Prerequisites
- **Node.js**: `v26.8.1` (or Node 18+)
- **npm**: `v9.0.0` or higher
- **PostgreSQL**: v13+ (Local instance or free cloud database like Aiven or Supabase)
- **Git**

---

### Step 1: Clone the Repository & Check Out the Branch

Clone the repository and make sure to check out the **generalized sheet** branch (`generalized-sheet-manupilation`):

```bash
# Clone the repository
git clone https://github.com/your-username/Echo.git
cd Echo

# Check out the active generalized sheet branch
git checkout generalized-sheet-manupilation
```

---

### Step 2: Configure & Start the Backend

1. Navigate to the `backend` folder and install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Set up your environment variables:
   ```bash
   # Copy the provided template
   cp .env.example .env
   ```

3. Open `backend/.env` in your text editor and configure:
   - `DATABASE_URL`: Your PostgreSQL connection string.
     - *Local example*: `postgresql://postgres:password@localhost:5432/maxitext_db`
     - *Cloud example (Aiven)*: `postgres://user:password@host:port/defaultdb?sslmode=require` (set `DB_SSL=true`)
   - `GEMINI_API_KEY`: Your Google AI Studio Gemini API key.
   - `SMTP_USER` / `SMTP_PASS`: Your Gmail and App Password for announcement testing (or keep `SMTP_TEST_MODE=true`).

4. Initialize the database schema and seed data:
   ```bash
   npm run db:init
   ```

5. Launch the backend server:
   ```bash
   npm run dev
   ```
   *The backend will start at **`http://localhost:3000`**.* Verify health status by visiting `http://localhost:3000/api/health`.

---

### Step 3: Configure & Start the Frontend

Open a new terminal window:

1. Navigate to the `frontend` folder and install dependencies:
   ```bash
   cd frontend
   npm install
   ```

2. **Verify Backend Connection URL**:
   Open `frontend/src/config/constants.js` and verify that the local backend URL is active:
   ```javascript
   export const BUSINESS_ID = "684a8863-5094-4c8b-9b15-c50c06335b7f";

   // Ensure this is set to http://localhost:3000 for local development:
   export const API_BASE_URL = "http://localhost:3000";
   ```

3. Start the Vite development server:
   ```bash
   npm run dev
   ```
   *The application frontend will start at **`http://localhost:5173`**.*

---

## 🌐 Local vs. Hosted Backend Configuration

MaxiText AI Studio supports both local development and hosted deployments:

| Environment | File Location | Configuration |
| :--- | :--- | :--- |
| **Local Development** | `frontend/src/config/constants.js` | `export const API_BASE_URL = "http://localhost:3000";` |
| **Production / Cloud Deployment** | `frontend/src/config/constants.js` | `export const API_BASE_URL = "https://your-production-backend.com";` |

The top navigation header includes a live **API Health Indicator** (`Connected to AI Studio API` or `Backend Offline (port 3000)`) that polls the backend health status every 15 seconds.

---

## 🖥 Two Distinct Workspaces

### 1. Customer Portal (`http://localhost:5173/customer`)
- Designed for end-customers to submit inquiries and receive prompt answers.
- **Registration**: Enter name and email to receive a secure, one-time Customer ID.
- **Resuming Session**: Use saved Customer ID or click "Resume Saved Browser Session" to load chat history.
- **Knowledge Scope**: Pre-trained on `customer.csv` and `products.csv` (Veloura luxury apparel, pricing, discounts, returns, logistics).

### 2. Company Inquiry & AI Workspace (`http://localhost:5173/company`)
- Designed for customer service representatives and operations managers.
- **Inquiry Tab**: Review incoming customer messages, view Gemini AI response drafts, edit suggestions inline, or dispatch replies directly.
- **Sheet Management Tab**: Live interactive spreadsheet supporting natural-language SQL queries, staged two-phase mutations with side-by-side diff previews, dynamic CSV uploads, and dynamic row addition for any business table.

---

## 🧪 Running Automated Tests

The backend includes a comprehensive automated test suite covering:
- Single and multi-table CSV ingestion, schema validation, and normalization.
- Natural language to parameterized SQL query translation.
- Arithmetic and percentage-based two-phase mutation staging and atomic commits.
- Business isolation, customer registration, and security rules.
- AI announcement drafting, natural-language date filtering, and bulk email delivery tracking.

Run the test suite from the repository root:

```bash
npm test --prefix backend
```

**Test Results**: **`60 / 60 tests passed`** (0 failures, 100% passing).

---

## 📚 User Documentation & Guides

For detailed, step-by-step end-user operating procedures, refer to:
- [**`USER_MANUAL.md`**](file:///c:/Users/USER/Desktop/Development/Echo/USER_MANUAL.md): Comprehensive user manual covering customer registration, chat demo texts, AI auto-reply editing, natural-language announcement filtering, universal multi-industry spreadsheet management, and generalized demo commands.

---

## 📄 License
This project is proprietary and confidential. Developed for demonstration and review as part of the MaxiText AI Studio platform.
