# Mercora Project Report

## What the project does

Mercora is an authenticated finance operations tool for ecommerce merchants. It turns exports from Shopify, Razorpay, banks, and COD/courier systems into one reconciliation view. A user creates a finance mission for a date range, uploads CSV files, and the system:

1. Stores the source files in Supabase Storage.
2. Identifies each file using its filename and CSV headers, with manual correction available.
3. Parses rows into `extracted_records` and converts them into canonical financial events such as sales, payments, fees, settlements, bank transactions, COD remittances, deductions, and RTO events.
4. Matches related events into transaction/settlement chains using deterministic ID, amount, date-window, fuzzy-reference, and batch logic.
5. Detects exceptions such as missing settlements or bank credits, timing differences, fees, refunds, duplicates, and unexplained variances.
6. Lets the merchant investigate exceptions with an AI finance agent and ask questions about the mission.

The result is a reviewable reconciliation workflow: every important record is linked to its source, exceptions can be explained with evidence, and uncertain cases can be escalated to a human.

## Overall architecture

```text
React/Vite frontend
        |
        v
Express + Bun API (auth-protected finance routes)
        |
        +--> Supabase Auth, PostgreSQL, and Storage
        |       core: merchants, customers, orders, payments
        |       finance: documents, records, events, matches, exceptions, judgments
        |       audit: append-only action history
        |
        +--> Deterministic finance pipeline
        |       ingest -> classify -> extract -> normalize -> reconcile -> detect
        |
        +--> Gemini LLM provider
                tool-calling investigation loop + structured final answers
```

The backend is organized by finance pipeline modules. PostgreSQL is the canonical source of financial truth; raw uploaded rows remain preserved separately from normalized events. Supabase Storage holds uploaded documents, while the React UI displays missions, events, matches, exceptions, AI explanations, and reasoning traces.

## LLM capabilities

Gemini is the only currently implemented LLM provider (`gemini-2.5-flash` by default, configurable through environment variables). The provider supports two modes:

- **Structured completion:** Gemini returns JSON constrained by a Zod-derived schema. This is used for committed exception judgments and Q&A answers.
- **Function/tool calling:** Gemini can choose investigation actions step by step. The agent loop allows up to six steps, executes the selected backend tools, feeds results back to Gemini, and then makes a final schema-constrained answer call.

The finance agent can:

- retrieve exception details and linked events;
- trace a complete order chain from sale/payment through settlement and bank credit;
- inspect a bank credit, candidate settlement batches, and prior confirmed bank-narration patterns;
- list open exceptions and summarize mission-level reconciliation data;
- search support tickets and refund records for relevant evidence; and
- explicitly request human review when evidence is insufficient.

For exception investigation, Gemini produces a classification (`MATCHED`, `FEE`, `REFUND`, `TIMING_DIFFERENCE`, `DUPLICATE`, `MISSING_RECORD`, `UNEXPLAINED`, or `REQUIRES_HUMAN_REVIEW`), confidence, explanation, cited evidence, and a recommended action. Evidence citations are checked against results actually returned during the investigation; unsupported citations are removed, and evidence-dependent classifications are downgraded to human review when proof is missing. Tool calls, results, model traces, and final judgments are recorded for auditability and shown in the UI.

The same agent loop powers mission-scoped Q&A. It answers questions about open exceptions, transaction chains, mission health, and available evidence, returns cited exception/evidence IDs, preserves conversation history through the frontend, and marks unrelated or unanswerable questions as out of scope.

## Important boundary

File classification, CSV parsing, normalization, matching, and exception detection are deterministic application code; they do not currently rely on an LLM. If no real Gemini API key is configured, the provider falls back to an offline mock response for local/demo use. Although the database and product definition leave room for Growth, CRM, Commerce, and additional connectors, the implemented application is currently focused on finance reconciliation.
