# Mercora

Mercora is an AI-native financial operations and reconciliation platform designed for modern ecommerce merchants. It ingests fragmented data across direct-to-consumer storefronts, payment gateways, marketplace settlements, bank statements, and courier remittances into a unified, audit-grade financial ledger.

Through a hybrid architecture combining a deterministic financial rules engine with an autonomous Gemini-powered investigation agent, Mercora validates transaction chains, isolates discrepancies, and generates grounded, evidence-backed resolutions.

---

## Key Capabilities

- **Unified Multi-Channel Ingestion**: Automatically detects, parses, and normalizes financial data from Shopify, Razorpay, Amazon Seller Central (Flat File V2), commercial bank statements, and Cash on Delivery (COD) / logistics partners.
- **Deterministic Reconciliation Engine**: Executes deterministic matching algorithms across order IDs, batch settlement references, date windows, amounts, and fuzzy bank narrations without relying on non-deterministic LLM parsing for core math.
- **End-to-End Transaction Chain Rebuilding**: Links initial customer orders through payment gateway authorizations, marketplace deductions, batch settlements, and ultimate bank statement deposits.
- **Automated Exception Detection**: Flags missing settlements, uncredited bank deposits, fee anomalies (such as excess logistics charges), unrecognized marketplace deductions, and unrecorded return clawbacks.
- **Grounded AI Investigation Agent**: Employs an iterative tool-calling loop using Google Gemini to retrieve transaction context, cross-reference corroborating evidence, classify exceptions, and propose merchant-ready actions.
- **Strict Evidence Verification**: Enforces auditability by programmatically validating LLM-cited evidence against active tool outputs, downgrading unsupported hypotheses to human review.
- **Interactive Mission Q&A**: Provides merchants with a conversational interface to query mission health, investigate specific order chains, and analyze open discrepancies.

---

## System Architecture

```text
+-------------------------------------------------------------------------+
|                           React / Vite Frontend                         |
|      (Missions, Exception Feeds, Reasoning Traces, Reconciliation UI)   |
+------------------------------------+------------------------------------+
                                     |
                                     v
+------------------------------------+------------------------------------+
|                       Express + Bun Backend API                         |
|          (Authentication, Route Controllers, Zod Schema Validation)     |
+-------------------+--------------------+--------------------+-----------+
                    |                    |                    |
                    v                    v                    v
+-------------------+---+  +-------------+------+  +----------+-----------+
|  Deterministic        |  |  Supabase Platform |  |  AI Investigation    |
|  Finance Pipeline     |  |                     |  |  Agent (Gemini)      |
|                       |  |  - Auth (JWT)       |  |                     |
|  1. Ingest & Classify |  |  - PostgreSQL       |  |  - Tool Calling     |
|  2. Raw Extraction    |  |    (Core & Finance) |  |    (Iterative Loop) |
|  3. Event Normalizing |  |  - Storage          |  |  - Grounded Evidence|
|  4. Match Execution   |  |    (Raw CSV/TSVs)   |  |    Validation       |
|  5. Exception Detect  |  |  - Audit Logs       |  |  - Structured JSON  |
+-----------------------+  +--------------------+  +----------------------+
```

---

## Reconciliation Engine and Processing Pipeline

The financial pipeline separates deterministic accounting logic from AI-driven analysis:

### 1. Ingestion and Format Classification
Files uploaded by merchants are stored in Supabase Storage. The classifier inspects file names and header structures to identify the source system (Shopify, Razorpay, Amazon, Bank, or Courier). The CSV extractor features dynamic delimiter sniffing to support comma, tab, and semicolon formats seamlessly (e.g., Amazon TSV exports saved with `.csv` extensions).

### 2. Event Normalization
Raw records are converted into standardized financial events in PostgreSQL:
- `SALE`: Gross order values and line items.
- `PAYMENT`: Gateway payment captures and processing fees.
- `SETTLEMENT`: Net batch payouts from payment aggregators and marketplaces.
- `BANK_TRANSACTION`: Bank statement credit and debit entries.
- `FEE` / `ADJUSTMENT`: Commission, referral, fulfillment, fixed closing, and statutory withholdings (TCS/TDS).
- `REFUND` / `RETURN_CLAWBACK`: Customer returns and marketplace clawbacks.

### 3. Matching and Chain Assembly
Deterministic matchers evaluate candidate transaction pairs using domain-specific heuristics:
- **Direct Reference Matching**: Matches order numbers and payment IDs between storefronts and gateways.
- **Batch Settlement Reconciliation**: Aggregates individual orders against gateway settlement batches.
- **Marketplace Dual-Sided Matching**: Reconciles Amazon Flat File settlements simultaneously against synthesized gross order values (0-90 day lookback) and bank credit entries (0-14 day deposit windows with narration keyword matching).
- **Bank Credit Disambiguation**: Matches net settlement totals to bank statement deposits using configurable time windows and fuzzy narrative pattern recognition.

### 4. Exception Detection
The engine evaluates unmatched events and variances, raising specific exception types:
- `MISSING_SETTLEMENT`: Gateway or marketplace payments not assigned to a payout batch.
- `UNMATCHED_BANK_CREDIT`: Bank credits lacking corresponding settlement confirmation.
- `AMAZON_UNKNOWN_DEDUCTION`: Unmapped deduction or fee codes from marketplace reports.
- `AMAZON_FEE_ANOMALY`: Weight or handling charges exceeding defined thresholds (e.g., over 10% of order value).
- `AMAZON_RETURN_CLAWBACK`: Marketplace return clawbacks lacking corroborating storefront return records.
- `TIMING_DIFFERENCE` / `FEE_VARIANCE`: Variances exceeding expected gateway fee schedules.

---

## AI Agent and Investigation Framework

When an exception is investigated or a merchant queries a mission, the Gemini-powered agent executes an autonomous, multi-step investigation:

1. **Tool-Calling Execution Loop**: The agent can perform up to six sequential tool invocations per investigation, including:
   - `get_exception_details`: Retrieves root exception attributes and linked events.
   - `trace_order_chain`: Traces a full transaction path across sales, payments, settlements, and bank deposits.
   - `get_amazon_deduction_context`: Extracts line-level Amazon settlement context, sibling charges, and linked store events.
   - `search_evidence`: Searches corroborating support tickets, communications, and dispute logs.
   - `inspect_bank_credit`: Evaluates bank narration patterns and candidate batch payouts.
2. **Grounded Evidence Validation**: Every claim cited in the agent's explanation must match an evidence reference generated during active tool executions. The validation layer strips unverified citations and automatically downgrades speculative conclusions to `REQUIRES_HUMAN_REVIEW`.
3. **Structured Judgments**: Final classifications (`MATCHED`, `FEE`, `REFUND`, `TIMING_DIFFERENCE`, `DUPLICATE`, `MISSING_RECORD`, `UNEXPLAINED`, or `REQUIRES_HUMAN_REVIEW`) are returned as strict JSON objects validated via Zod schemas, persisted to the database, and rendered alongside step-by-step reasoning traces in the UI.

---

## Repository Structure

```text
.
├── backend/                        # Express + Bun API Server
│   ├── src/
│   │   ├── api/                    # Route handlers and middleware
│   │   ├── lib/                    # Supabase client, Gemini LLM provider, utilities
│   │   ├── modules/finance/
│   │   │   ├── exceptions/         # Deterministic exception detection rules
│   │   │   ├── extract/            # CSV/TSV parser with delimiter sniffing
│   │   │   ├── ingest/             # Document upload and raw record ingestion
│   │   │   ├── investigate/        # AI investigation runner, tools, and evidence validator
│   │   │   ├── judge/              # Structured judgment engine
│   │   │   ├── normalize/          # Source adapters (Shopify, Razorpay, Amazon, Bank, COD)
│   │   │   ├── qa/                 # Mission-scoped Q&A agent workflow
│   │   │   ├── reconcile/          # Deterministic matching and chain building
│   │   │   ├── shared/             # Domain types, Zod schemas, and constants
│   │   │   ├── summary/            # Mission reconciliation metrics and rollups
│   │   │   └── understand/         # Header and filename source classification
│   │   ├── routes/                 # Express route definitions
│   │   └── index.ts                # Server entry point
│   ├── sql/                        # Migration scripts and database helpers
│   ├── package.json
│   └── tsconfig.json
├── frontend/                       # React 19 + Vite Web Application
│   ├── src/
│   │   ├── components/             # Reusable UI components, tables, reasoning trace viewers
│   │   ├── pages/                  # Mission overview, upload, reconciliation, and summary pages
│   │   ├── lib/                    # API client, Supabase auth helpers, formatters
│   │   ├── App.tsx                 # Main application shell and routing
│   │   └── main.tsx                # Frontend entry point
│   ├── package.json
│   └── vite.config.ts
├── synthetic-data/                 # Sample multi-channel financial datasets for testing
├── mercora_schema.sql              # Complete PostgreSQL schema definitions
├── mercora_product_definition.md   # Core product architecture and vision
├── PROJECT_REPORT.md               # Detailed technical implementation report
└── README.md
```

---

## Getting Started

### Prerequisites

- **Bun** (v1.0 or higher) for the backend runtime
- **Node.js** (v20 or higher) and **npm** for the frontend application
- **Supabase Account** (or local Supabase instance) with PostgreSQL and Storage enabled
- **Google Gemini API Key** (for AI agent workflows; offline mock mode supported if omitted)

---

### Database Setup

1. Create a new Supabase project.
2. Navigate to the SQL Editor in your Supabase dashboard.
3. Execute the contents of `mercora_schema.sql` to initialize schemas, tables, enums, indexes, and Row Level Security (RLS) policies across `core`, `finance`, and `audit` namespaces.
4. Create a private storage bucket named `finance_documents` in Supabase Storage.

---

### Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Create and configure your environment file:
   ```bash
   cp .env.example .env
   ```

4. Configure the required environment variables in `backend/.env`:
   ```env
   PORT=5001
   FRONTEND_URL=http://localhost:5173
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-supabase-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
   NODE_ENV=development

   # LLM Configuration
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=your-gemini-api-key
   GEMINI_MODEL=gemini-2.5-flash
   GEMINI_JUDGE_MODEL=gemini-2.5-flash
   ```

5. Start the backend development server:
   ```bash
   bun run dev
   ```

The backend API will run at `http://localhost:5001`.

---

### Frontend Setup

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create and configure your environment file:
   ```bash
   cp .env.example .env
   ```

4. Configure the required environment variables in `frontend/.env`:
   ```env
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
   VITE_BACKEND_URL=http://localhost:5001
   ```

5. Start the Vite development server:
   ```bash
   npm run dev
   ```

The application will be accessible at `http://localhost:5173`.

---

## Testing and Verification

The backend includes test suites and end-to-end reconciliation verification scripts:

- **Type Checking**:
  ```bash
  cd backend && bun run build
  cd frontend && npm run build
  ```

- **Run Document Classification Tests**:
  ```bash
  cd backend && bun test src/modules/finance/understand/classify.test.ts
  ```

- **Run End-to-End Reconciliation Test Scripts**:
  ```bash
  cd backend && bun src/test-finance-reconcile-e2e.ts
  ```

---

## Technical Specifications and Design Boundaries

- **Preservation of Raw Inputs**: Uploaded rows are preserved verbatim in `finance.extracted_records` before transformation, ensuring financial audits can always trace back to original source files.
- **Deterministic Boundary**: Parsing, source classification, event normalization, matching algorithms, and exception detection are executed strictly via deterministic code. The LLM is never utilized for arithmetic calculations.
- **Fail-Safe Fallbacks**: If no Gemini API key is supplied, the AI provider falls back to deterministic local mock handlers, allowing local evaluation and UI testing without external API dependencies.
