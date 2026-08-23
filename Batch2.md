# Mercora Finance Agent — Batch 2 Build Spec

## Context (read first, do not skip)

You are extending an existing project called **Mercora**, an AI-native merchant
operating system. We are building the **Finance Agent** first, in incremental
batches. This is **Batch 2**.

**Stack (already set up — do not change or re-scaffold it):**
- Frontend: React (already configured)
- Backend: Bun + TypeScript + Express (already configured)
- Auth + DB: Supabase (Postgres). Auth is already wired up.
- Database schema is **already migrated** to Supabase. It lives across three
  Postgres schemas: `core`, `finance`, `audit`. The full DDL is attached
  (`mercora_schema.sql`) — **read it fully before writing any code**. Do not
  invent columns or tables that aren't in that file. If something you need
  doesn't exist in the schema, stop and flag it instead of silently adding a
  migration.
- `core`, `finance`, and `audit` are exposed via Supabase's API (Project
  Settings → Exposed schemas), so the backend can query them via
  `supabase.schema('finance').from('normalized_events')...` using the
  **service role key**. All backend writes to Supabase must use the service
  role client — never the anon key — since this pipeline runs as a trusted
  system process, not as a request-scoped user action.

**What Batch 1 already delivered:** the schema only. No backend code exists
for the finance pipeline yet. You are building the first real slice of it.

---

## What Batch 2 covers (and what it explicitly does NOT)

Batch 2 implements the first four pipeline stages, for **CSV sources only**:

```
INGEST → UNDERSTAND → EXTRACT (csv only) → NORMALIZE
```

**Explicitly out of scope for this batch — do not build these yet:**
- PDF/image extraction or any Gemini/LLM calls of any kind. This batch has
  **zero AI involvement**. It is pure deterministic pipeline code.
- Reconciliation / matching (`finance.matches`)
- Exception detection (`finance.exceptions`)
- Investigation, judging, evidence, human review, close reports
- Any queue/worker infrastructure (BullMQ, Redis, etc.) — process synchronously
  in-request or with a simple async function call, nothing fancier.

If you find yourself about to write matching logic or call an LLM, stop —
that's Batch 3+.

---

## Business context you need to implement this correctly

Three source types exist for this batch, each a CSV:

1. **Shopify orders export** — represents `SALE` events (and sometimes
   `REFUND` if status indicates a refund).
2. **Razorpay transactions export** — represents `PAYMENT`, `FEE`, and
   `SETTLEMENT` events (a single Razorpay row can produce multiple
   normalized events — see Normalize section below).
3. **Bank statement export** — represents `BANK_TRANSACTION` events.

We do not have real merchant data yet. **You must also build a synthetic data
generator** (a standalone script, not part of the runtime app) that produces
these three CSVs so the pipeline can actually be tested end to end. Use the
exact column schemas below — later batches (reconciliation) depend on this
generator producing internally-consistent, linkable data, so don't deviate
from these shapes.

### CSV schema: `shopify_orders.csv`
| column | type | notes |
|---|---|---|
| order_id | string | unique per order, e.g. `#SHF-1001` |
| order_number | string | human-readable, e.g. `1001` |
| customer_name | string | |
| customer_email | string | |
| order_date | date `YYYY-MM-DD` | |
| total_amount | decimal | INR, 2dp |
| currency | string | always `INR` |
| status | enum string | `paid`, `refunded`, `partially_refunded`, `cancelled` |
| refund_amount | decimal, nullable | populated when status implies a refund |

### CSV schema: `razorpay_transactions.csv`
| column | type | notes |
|---|---|---|
| payment_id | string | e.g. `pay_XXXXXXXXXXXX` |
| order_ref | string | **must match a `shopify_orders.order_id` or `order_number`** so normalization can link them — this is how a PAYMENT event ties back to a SALE event |
| payment_date | date `YYYY-MM-DD` | |
| gross_amount | decimal | amount before fees |
| fee_amount | decimal | Razorpay's cut |
| tax_on_fee | decimal | GST on the fee, if you want realism |
| net_amount | decimal | gross - fee - tax_on_fee |
| settlement_id | string | e.g. `setl_XXXXXXXXXXXX` |
| settlement_date | date `YYYY-MM-DD` | usually a few days after payment_date |
| status | enum string | `captured`, `refunded`, `failed` |

### CSV schema: `bank_statement.csv`
| column | type | notes |
|---|---|---|
| transaction_date | date `YYYY-MM-DD` | |
| description | string | should embed the `settlement_id` where realistic, e.g. `"NEFT RAZORPAY SETL setl_XXXXXXXXXXXX"`, so future fuzzy matching has something to find |
| credit_amount | decimal, nullable | money in |
| debit_amount | decimal, nullable | money out |
| reference_number | string, nullable | bank's own ref, not always present — real bank statements are messy, so leave this blank on ~30% of rows intentionally |

Generate **~40 linked orders** (Shopify → Razorpay → Bank, mostly clean
1:1:1 chains) using this generator. You do not need to inject the "messy"
mismatches (duplicates, missing settlements, unexplained differences) yet —
that's for the reconciliation batch — but do **not artificially make every
row perfectly clean either**; real exports have things like inconsistent
date formats between systems, occasional blank optional fields, and mixed
casing in status strings. Keep the CSVs realistic-messy but every economic
event should still be traceable end-to-end for now. Output the three CSVs
to a `/synthetic-data` folder at the project root along with a
`ground_truth.json` documenting which order_id/payment_id/settlement_id
chains are linked — this ground truth file will be used by later batches to
validate the reconciliation matcher, so keep it accurate.

---

## Stage-by-stage implementation requirements

### 1. Ingest

**Endpoint:** `POST /api/finance/missions/:missionId/documents`
- Accepts `multipart/form-data` file upload.
- Upload the raw file to Supabase Storage (create a bucket named
  `finance-documents` if it doesn't exist yet — check first, don't error if
  it's already there). Path convention:
  `{merchant_id}/{mission_id}/{uuid}-{original_filename}`.
- Insert a row into `finance.source_documents` with `file_path`,
  `original_filename`, `mime_type`, `mission_id`, `merchant_id`. Leave
  `detected_source` as `unknown` for now — Understand stage fills it in
  next.
- Write an `audit.audit_log` entry: `action = 'document.uploaded'`,
  `actor_type = 'user'`, `entity_type = 'finance.source_documents'`.
- Response: the created `source_documents` row as JSON.

**Also needed — mission creation, since documents need a mission to attach to:**

**Endpoint:** `POST /api/finance/missions`
- Body: `{ period_start, period_end, sources: string[], objective?: string }`
- Validates `period_end >= period_start` (also enforced by DB constraint,
  but fail fast with a clean 400 before hitting Postgres).
- Insert into `finance.finance_missions`, status `created`.
- Write audit log entry: `action = 'mission.created'`.

### 2. Understand (source classification)

**Endpoint:** `POST /api/finance/missions/:missionId/documents/:documentId/classify`
(Can also be called automatically right after upload — your choice, but
expose it as its own callable step so the FE can show "classifying..." as a
distinct state.)

Classification logic — **filename + content heuristics only, no LLM in this
batch**:
- Filename contains `shopify` or `order` → candidate `shopify_orders`
- Filename contains `razorpay` or `settlement` or `payment` → candidate
  `razorpay_settlement`
- Filename contains `bank` or `statement` or a bank name (`hdfc`, `icici`,
  `sbi`, `axis`) → candidate `bank_statement`
- If filename gives no signal, **open the CSV and check the header row**:
  - Headers containing `order_id` + `customer_email` → `shopify_orders`
  - Headers containing `payment_id` + `settlement_id` → `razorpay_settlement`
  - Headers containing `transaction_date` + (`credit_amount` or
    `debit_amount`) → `bank_statement`
  - Otherwise → `unknown`
- Compute a `detection_confidence` (0–100): 90+ for filename match confirmed
  by header match, 70 for header-only match, 40 for filename-only match with
  header mismatch (flag this as suspicious in the response), 0 for
  `unknown`.
- Set `detection_method` to `filename_heuristic` if filename alone decided
  it, otherwise it still counts as `filename_heuristic` unless you had to
  fall back to headers — in that case still use `filename_heuristic` (we're
  reserving `gemini_classified` strictly for a future batch; don't use it
  here even though header-sniffing feels smarter — it's still deterministic
  code, not a model call, so it belongs in this heuristic method value).
- Update the `source_documents` row: `detected_source`, `detection_method`,
  `detection_confidence`.
- **Support user correction:** `PATCH /api/finance/missions/:missionId/documents/:documentId`
  body `{ detected_source }`, sets `detection_method = 'user_corrected'`,
  `detection_confidence = 100`. Write an audit log entry for this override.

### 3. Extract (CSV only)

**Endpoint:** `POST /api/finance/missions/:missionId/documents/:documentId/extract`

- Only proceeds if `detected_source` is one of the three known types (not
  `unknown`) — return a 422 with a clear message otherwise.
- Download the file from Supabase Storage, parse as CSV (use `papaparse` or
  `csv-parse` — your call, pick one and be consistent).
- For **every row**, insert one `finance.extracted_records` row:
  - `raw_json` = the row as parsed, untouched, keys exactly as in the CSV
    header (don't rename/reshape yet — that's Normalize's job).
  - `extraction_method = 'csv_parse'`
  - `extraction_confidence = 100` (CSV parsing is deterministic; reserve
    lower confidence values for the future Gemini vision path)
  - `source_document_id`, `mission_id`, `merchant_id` set correctly.
- Batch-insert for performance — don't do 40 individual round-trips to
  Supabase, use a single insert with an array of rows.
- Response: count of records extracted, plus a small sample (first 3 rows)
  for the FE to sanity-check.

### 4. Normalize

**Endpoint:** `POST /api/finance/missions/:missionId/normalize`

This runs across **all** `extracted_records` for the mission that haven't
been normalized yet (track this either via a `normalized_events.extracted_record_id`
existence check, or add a lightweight in-memory/query-based "already
processed" check — do not add a new schema column without flagging it to me
first, since the schema file is the source of truth).

Write one mapping function per source type. Each takes an `extracted_records`
row's `raw_json` and returns zero or more `normalized_events` rows to insert.

**`mapShopifyOrder(raw)` →**
- One `SALE` event: `amount = total_amount`, `event_date = order_date`,
  `external_ref = order_id`, `source_system = 'shopify'`,
  `counterparty = customer_name`.
- If `status` is `refunded` or `partially_refunded` and `refund_amount` is
  present: also emit one `REFUND` event, `amount = refund_amount` (as a
  positive number — sign/direction is a display concern, not a storage
  concern), same `event_date`, `external_ref = order_id + '-refund'`.
- **Upsert into `core.customers`** first (match on `merchant_id` +
  `external_ref` — you'll need to decide what external_ref means for a
  customer; since Shopify orders CSV only gives name/email, use email as
  the customer external_ref), then **upsert into `core.orders`**
  (`external_ref = order_id`, `unique(merchant_id, external_ref)` — this
  constraint already exists, so use `upsert` with `onConflict`). Link the
  new `SALE` normalized_event's `order_id` and `customer_id` columns to
  these core rows.

**`mapRazorpayTransaction(raw)` →** three events from one CSV row:
- `PAYMENT`: `amount = gross_amount`, `event_date = payment_date`,
  `external_ref = payment_id`, `source_system = 'razorpay'`.
- `FEE`: `amount = fee_amount + tax_on_fee`, same `event_date`,
  `external_ref = payment_id + '-fee'`, `source_system = 'razorpay'`.
- `SETTLEMENT`: `amount = net_amount`, `event_date = settlement_date`,
  `external_ref = settlement_id`, `source_system = 'razorpay'`.
- Upsert into `core.payments` (`external_ref = payment_id`) for the PAYMENT
  event's link. **Also attempt to resolve `order_id`**: look up
  `core.orders` where `external_ref = raw.order_ref` (matches either the
  Shopify `order_id` or `order_number` depending on which the generator
  used — check both) for the same `merchant_id`; if found, set both the new
  `core.payments.order_id` and the `PAYMENT` normalized_event's `order_id`.
  If not found, leave it null and do **not** fail the whole normalize run —
  log it and continue. (This cross-source linking is exactly why Shopify
  should typically be normalized before Razorpay in a given run — process
  sources in this fixed order: shopify → razorpay → bank.)

**`mapBankTransaction(raw)` →**
- One `BANK_TRANSACTION` event: `amount = credit_amount` if present
  (positive/inbound) else `debit_amount` (also store as positive; use
  `metadata.direction = 'credit' | 'debit'` to preserve sign meaning —
  don't invent a new column), `event_date = transaction_date`,
  `external_ref = reference_number` (nullable — that's fine, bank data is
  often like this), `source_system = 'bank'`, `counterparty = description`.
  No core.* linking attempt needed for bank rows in this batch (that's a
  reconciliation-time job, not normalize-time).

**All three mapping functions must:**
- Set `metadata` to include at minimum `{ "raw_source_row": <original row keys not otherwise mapped> }` so nothing is silently dropped.
- Be pure functions (input: raw row + merchant_id + mission_id + extracted_record_id, output: array of event objects ready to insert) so they're unit-testable without hitting the DB.
- Batch insert results into `finance.normalized_events`.

Write an `audit.audit_log` entry summarizing the normalize run:
`action = 'mission.normalized'`, `after = { events_created: N, by_type: {...} }`.

After normalization completes for all documents in a mission, update
`finance.finance_missions.status` to `'ingesting'` if any documents are
still unprocessed, or leave for the FE to decide — actually: set it to
`'reconciling'` once every uploaded document has been extracted AND
normalized, since reconciling is genuinely the next stage even though we
aren't building it yet. This just keeps mission status meaningful.

---

## Required TypeScript structure

Follow this exactly (create files even if some start thin):

```
/src
  /modules/finance
    /ingest
      routes.ts          -- POST /missions, POST /missions/:id/documents
      storage.ts          -- supabase storage upload helper
    /understand
      classify.ts          -- heuristic classifier, pure function
      routes.ts
    /extract
      csv.ts               -- csv parsing + extracted_records insert
      routes.ts
    /normalize
      shopify.ts            -- mapShopifyOrder
      razorpay.ts             -- mapRazorpayTransaction
      bank.ts                  -- mapBankTransaction
      run.ts                    -- orchestrates: fetch unnormalized records, dispatch by source, batch insert
      routes.ts
    /shared
      types.ts               -- TS types mirroring every relevant table in mercora_schema.sql (generate these by hand from the DDL, keep them in sync)
      audit.ts                -- single writeAuditLog() function every stage calls
  /shared
    /db
      supabase.ts             -- service-role client factory
  /api
    finance.routes.ts          -- mounts all the above route modules under /api/finance
/synthetic-data
  generate.ts                  -- the CSV + ground_truth.json generator script (run via `bun run synthetic-data/generate.ts`, not part of the server)
  shopify_orders.csv           -- generator output, checked into repo for repeatable testing
  razorpay_transactions.csv
  bank_statement.csv
  ground_truth.json
```

Use **Zod** to validate every request body before touching the DB. Put
schemas next to their route files or in `types.ts` — your call, but be
consistent.

---

## Frontend requirements (this batch must be testable end-to-end via UI — do not skip this)

Add a new route/page: **`/finance`** (or nest under an existing dashboard
shell if one exists — match whatever routing pattern is already in the
React app).

The page needs, in this order, as a simple vertical flow (no need for
polish/design system work yet — this is a test harness, function over
form):

1. **Mission creation form**: period start date, period end date, a
   multi-select or checkboxes for sources (`shopify`, `razorpay`, `bank`),
   optional objective text field, "Create Mission" button. On success, show
   the created mission and move to step 2.

2. **Document upload area**: once a mission exists, show a file drop
   zone / file input. Let the user upload the three synthetic CSVs (or any
   CSV) one at a time or multi-select. After each upload, immediately call
   the classify endpoint and show the result inline: filename, detected
   source badge, confidence %, and a small dropdown to manually override
   `detected_source` if it's wrong (wire this to the PATCH endpoint).

3. **"Extract & Normalize" button**: once at least one document is
   classified, show a button that calls extract for each classified
   document sequentially, then calls the normalize endpoint. Show a simple
   status log as it progresses (e.g. a scrolling list: "Extracting
   shopify_orders.csv... 42 records extracted", "Normalizing... 126 events
   created"). Don't over-engineer this into a websocket/streaming thing —
   sequential await calls with status text updates between them is fine.

4. **Normalized events table**: after normalization, fetch and render
   `finance.normalized_events` for the mission in a plain sortable table:
   columns `event_type`, `source_system`, `external_ref`, `amount`,
   `event_date`, `counterparty`, and a `linked?` column showing whether
   `order_id`/`payment_id`/`customer_id` is populated (just render a ✓/—).
   Add simple client-side filter dropdowns for `event_type` and
   `source_system` — this table is how you and I will visually confirm the
   normalize logic is correct, so it needs to be genuinely usable, not just
   present.

Add the corresponding `GET` endpoints needed to support this view:
- `GET /api/finance/missions/:id` — mission detail
- `GET /api/finance/missions/:id/documents` — list with classification state
- `GET /api/finance/missions/:id/events?event_type=&source_system=` — normalized events, filterable

---

## Non-negotiable rules (carried over from the overall project spec — do not violate)

- No LLM calls anywhere in this batch. If Gemini is imported anywhere, that's wrong.
- No arithmetic correctness decisions made anywhere except SQL/Postgres and plain TS — nothing here needs an LLM to begin with, so this should be trivially true, but stating it explicitly.
- Every mutating action (document upload, classification, extraction, normalization, manual override) writes to `audit.audit_log` via the single shared `writeAuditLog()` helper — no ad hoc logging.
- Use the Supabase **service role key** on the backend, never expose it to the frontend.
- Respect existing unique constraints (`core.orders(merchant_id, external_ref)`, `core.payments(merchant_id, external_ref)`, `core.customers(merchant_id, external_ref)`) via `upsert` with `onConflict`, don't pre-check-then-insert (race-prone and slower).
- Do not modify `mercora_schema.sql` or add new columns/tables without stopping and asking first.

---

## Acceptance criteria — how I will verify this batch is done

1. I can go to `/finance` in the browser, create a mission, upload all three
   synthetic CSVs, see each correctly auto-classified with >70% confidence,
   click one button to extract+normalize, and see a populated events table
   with the correct mix of `SALE`, `REFUND`, `PAYMENT`, `FEE`, `SETTLEMENT`,
   `BANK_TRANSACTION` rows.
2. Every Shopify `SALE` event with a matching Razorpay `order_ref` shows
   `linked = ✓` for `order_id`.
3. Re-running normalize on the same mission does not create duplicate
   `normalized_events` (idempotent).
4. `audit.audit_log` has a row for every upload, classification, override
   (if any), and normalize run.
5. `bun run synthetic-data/generate.ts` regenerates the three CSVs and
   `ground_truth.json` deterministically from a fixed seed, so I can re-run
   tests reproducibly.

If any of these can't be satisfied with the schema as given, stop and tell
me instead of working around it silently.