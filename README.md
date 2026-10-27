# Echo — Intelligent Customer-Support Assistant & Knowledge Engine

Echo is an intelligent customer-support assistant backend and knowledge engine designed to ingest structured business context (CSV and spreadsheets), generate contextual prompts for LLMs, and safely query and mutate tabular business data (such as products, services, and customer records) using natural language.

---

## 🌟 Key Features

- **Contextual Knowledge Ingestion**: Seamlessly ingest and parse structured CSV data (`sample-context.csv`, `sample-customers.csv`, `sample-products.csv`, `sample-services.csv`) into relational PostgreSQL tables.
- **Natural-Language Spreadsheet Interface**:
  - **Schema Validation**: Enforces strict canonical schemas for products and services via `sheetSchemaService`.
  - **Natural Language to Safe SQL**: Uses LLM prompt engineering to interpret user requests into structured query definitions, executing parameterized SQL rather than raw model-generated SQL.
  - **Two-Phase Mutations**: Safe data modifications with mandatory preview steps and explicit user confirmation (`confirm: true`) inside transactional boundaries.
- **Contextual Prompt Generation**: Builds contextual prompt payloads for customer-support interactions incorporating verified business context.
- **Robust REST API**: Built with Node.js, Express, Helmet, Morgan, and PostgreSQL.

---

## 📁 Project Structure

```text
Echo/
├── backend/
│   ├── db/                 # Database initialization and connection pool
│   ├── src/
│   │   ├── config/         # App configuration & environment loader
│   │   ├── controllers/    # Route controllers (support, sheets, etc.)
│   │   ├── middleware/     # Error handlers and file upload (Multer)
│   │   ├── routes/         # Express router definitions
│   │   ├── services/       # Core business logic, query builders, and mutations
│   │   ├── utils/          # Helper utilities and validators
│   │   ├── app.js          # Express app configuration
│   │   └── server.js       # HTTP server entrypoint
│   ├── test/               # Workflow and integration tests
│   ├── .env.example        # Environment variable template
│   ├── package.json        # Dependencies and scripts
│   ├── USER_MANUAL.md      # Comprehensive setup and API manual
│   └── SHEET_FEATURE_USER_MANUAL.md # Natural language spreadsheet manual
├── frontend/               # Frontend client application workspace
├── .gitignore              # Root git ignore file
└── README.md               # Project documentation
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: `v26.8.1` or higher
- **PostgreSQL**: v13+ (local instance or cloud-hosted database such as Aiven or Supabase)
- **npm**: Node package manager

### 1. Installation

Clone the repository and install backend dependencies:

```bash
cd backend
npm install
```

### 2. Environment Configuration

Copy the example environment file and configure your credentials:

```bash
cp .env.example .env
```

Key variables in `backend/.env`:
- `PORT`: Server listening port (default: `3000`)
- `HOST`: Server host (default: `localhost`)
- `DATABASE_URL`: PostgreSQL connection string (e.g. `postgresql://user:password@host:port/database?sslmode=require`)
- `GEMINI_API_KEY`: API key for natural language query generation (optional/as needed)

### 3. Database Initialization

Run the database initialization script to create the necessary schema:

```bash
cd backend
npm run db:init
```

### 4. Running the Server

Start in development mode with auto-reload:

```bash
cd backend
npm run dev
```

Or start the production server:

```bash
cd backend
npm start
```

### 5. Running Tests

Execute the test suites:

```bash
cd backend
npm test
```

---

## 📖 Documentation

For in-depth guides and API references, check:
- [Echo User Manual](file:///backend/USER_MANUAL.md): Complete setup guide, CSV ingestion format, and endpoint testing.
- [Natural Language Sheet Query Manual](file:///backend/SHEET_FEATURE_USER_MANUAL.md): Schema validation, two-phase mutation safeguards, and Gemini prompt integration.

---

## 📄 License

ISC License.
