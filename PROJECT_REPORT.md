# Mercora Project Report

## What the project does

Mercora is an authenticated finance operations tool for ecommerce merchants. It turns exports from Shopify, Razorpay, Amazon, banks, and COD/courier systems into one reconciliation view. A user creates a finance mission for a date range, uploads CSV files, and the system:

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

## Amazon settlement reconciliation

Two commits (`81c154d` "add Amazon settlement processing with flat file parser and classification support" and `b55b0cc` "integrate Amazon settlement data into evidence tracking and investigation workflows") added a full Amazon Seller Central reconciliation path alongside the existing Razorpay/COD ones. Together they cover ingestion, normalization, matching, exception detection, and AI investigation.

**Ingestion and classification.** Amazon's Seller Central "Flat File V2" settlement export is a 24-column report that is tab-delimited even when saved with a `.csv`/`.txt` extension. `extract/csv.ts` now sniffs the delimiter (`\t`/`,`/`;`) before parsing. The document classifier (`understand/classify.ts`) recognizes the file by filename (`amazon`, `mtr`) or by header signature (`settlement-id`, `amount-type`, `amount-description`, `amount`, `posted-date`) and tags it as the new `amazon_settlement` detected source / `amazon` source system.

**Normalization (`normalize/amazon.ts`, `normalize/adapters/amazon.adapter.ts`).** Each settlement batch (grouped by `settlement-id`) is normalized into:

- One `AMAZON_SETTLEMENT` event for the batch total (stored as a `SETTLEMENT` in the DB), carrying a default 0–14 day bank-credit window.
- One synthetic `SALE` event per order, built by summing the positive "Principal"/order-level credit lines for that `merchant-order-id`/`order-id` — Mercora does not require a separate Amazon orders export; the settlement file is the source of the order's gross value. The adapter looks up `core.orders` by `external_ref`/`order_number` to attach an `order_id` when the order already exists (e.g., seeded by the Shopify orders CSV), but reconciliation still works even if no match is found.
- One `FEE` / `REFUND` / `ADJUSTMENT` event per raw settlement line, deterministically classified by `classifyAmazonLine` into categories such as referral fee, closing fee, fulfillment fee, weight/handling fee, shipping fee, storage fee, statutory TCS/TDS withholding, promotional rebate, reserve/balance movement, return/refund clawback, or `unrecognized_deduction` when the code doesn't match any known vocabulary (Amazon's amount-description list is not exhaustively documented, so unknown codes are deliberately preserved rather than guessed at). Lines also carry an `is_return_clawback` flag and, for weight/handling fees over 10% of the order's gross value, an `anomaly_flags: ["weight_charge_over_10_percent_of_order"]` marker.

**What the settlement reconciles against — both the bank statement and the orders, not just one:**

1. *Settlement → bank credit.* The `AMAZON_SETTLEMENT` event is added to the same bank-credit disambiguation pool used for Razorpay/COD (`reconcile/matcher.ts`). Amazon narration keywords (`amazon`, `amazon pay`, `amazon marketplace`, `amzn`) and a 0–14 day deposit window (ideal 3 days) are used to match it to a bank statement credit line.
2. *Settlement → orders.* The per-order `SALE` events synthesized from the settlement's Principal lines are matched back against the settlement batch itself, treated like a marketplace remittance (similar to COD payouts) with a wide 0–90 day lookback window (`getMarketplaceSaleWindow`), since Amazon can post deductions and clawbacks long after the original order.

So the full reconciled chain is: **Amazon order (Principal line in the settlement) → Amazon settlement batch (with line-level fees/deductions/refunds) → bank credit.**

**Exception detection (`exceptions/detect.ts`).** New exception types: `amazon_unknown_deduction` (an `unrecognized_deduction` code), `amazon_fee_anomaly` (a weight/handling fee flagged over 10% of order value), and `amazon_return_clawback` (a return/refund line with no corroborating Shopify `REFUND` event for the same order — i.e., Amazon clawed back money for a return Mercora has no other record of). Known statutory withholdings (TCS/TDS) are explicitly excluded from exceptions.

**AI investigation (`b55b0cc`, building on `81c154d`'s agent wiring).** A new agent tool, `get_amazon_deduction_context`, lets Gemini retrieve the exact settlement line for an exception, its sibling lines in the same batch/order, the linked core order, and any Shopify refund event for that order, plus a list of `evidence_refs` it is allowed to cite. `b55b0cc` wires this tool's results into the same evidence pipeline as `search_evidence`: a new `amazon_settlement` evidence source type was added to the DB enum, `investigate/validate.ts` now accepts `evidence_refs` returned by `get_amazon_deduction_context` (not just `search_evidence` results) as legitimate citations, and evidence rows reconstructed from this tool are persisted with `found_by: "gemini_retrieval"`. The agent's structured judgment schema also gained an optional `merchant_category` field (e.g., "referral fee", "weight or handling fee", "other marketplace deduction", "unresolved") — populated only when the retrieved Amazon context actually supports one of those labels, never invented from memory — which then gets persisted back onto the Amazon event's `metadata.deduction_label` for unfamiliar codes the agent successfully resolved. If the evidence doesn't support a confident category, the agent must classify the exception as `REQUIRES_HUMAN_REVIEW` instead.

## Important boundary

File classification, CSV parsing, normalization, matching, and exception detection are deterministic application code; they do not currently rely on an LLM. If no real Gemini API key is configured, the provider falls back to an offline mock response for local/demo use. Although the database and product definition leave room for Growth, CRM, Commerce, and additional connectors, the implemented application is currently focused on finance reconciliation.
