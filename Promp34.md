# Mercora Finance Agent — Batch 3 & 4 Build Spec

## Read this correction first — it applies to everything below

**"Batch" is our internal build-sequencing term. It is not, and must never
become, a concept inside the product.** In the previous round, the pipeline
got built as if "Batch 2" were a bounded feature — as if extract/normalize
were the whole product and the mission's lifecycle ended there. That's
wrong and needs to be corrected going forward.

The real product is **one continuous thing**: a Finance Mission that moves
through `INGEST → UNDERSTAND → EXTRACT → NORMALIZE → RECONCILE → DETECT
EXCEPTIONS → INVESTIGATE → JUDGE → HUMAN REVIEW → CLOSE`. Batches 1–2 built
the first half of that pipeline. Batch 3–4, below, are not a new feature or
a new mode — they are **the next stages of the exact same mission**, using
the exact same `finance_missions` row, the exact same `/api/finance/missions/:id`
namespace, the exact same normalized_events already sitting in the DB from
the previous batch's test run.

Concretely, this means:
- Do **not** create any route, table, UI label, filename, or variable named
  after "batch2"/"batch3"/"phase3" etc. If you see any such naming left
  over from the last round, rename it to what it actually is (e.g.
  `normalize.ts` not `batch2Normalize.ts`).
- Do **not** gate reconciliation behind a separate "start batch 3" action in
  the UI. It's the natural next step for any mission whose status is
  `reconciling` — which Batch 2 already sets automatically once normalize
  completes.
- Do **not** design a new mission-creation flow. Missions created in Batch 2
  testing should be reconcilable as-is once you extend the generator (see
  below).
- Think of yourself as **continuing the Finance Agent's real pipeline**, not
  completing an assignment called "Batch 3." The batch number is scaffolding
  for us, the humans, to scope conversations — it has no footprint in the
  codebase or the UI.

Read `mercora_schema.sql` again in full before writing code — no schema
changes without stopping and asking first, same rule as last time.

---

# BATCH 3 — Reconcile + Detect Exceptions

Fully deterministic. **No LLM calls in this batch** — that starts in Batch 4.

## Extend the synthetic data generator first

The Batch 2 generator was told to produce clean, linkable chains with no
injected mismatches. That was correct for testing extract/normalize, but
reconciliation has nothing to detect against clean data. **Extend
`/synthetic-data/generate.ts`** (don't fork a new script) to inject, on top
of the ~40 clean chains already produced, a small set of deliberate
anomalies within the same three CSVs:

| Anomaly | Count | How to construct it |
|---|---|---|
| Timing outlier | 2 | Bank credit lands 10+ days after settlement instead of the usual 1–5 day window |
| Missing settlement | 1 | Razorpay row has `payment_id` but the row simulating settlement is simply omitted — payment captured, no settlement/bank leg follows |
| Missing bank credit | 1 | Settlement exists in Razorpay CSV, corresponding bank statement row is omitted |
| Duplicate | 1 | Same Razorpay `payment_id`/amount/date appears twice in the CSV (simulates a duplicate export row) |
| Small unexplained delta | 1 | Bank credit is off from expected net settlement amount by a small amount (e.g. ₹500) with no fee/refund/adjustment anywhere in the data to explain it — this one is intentionally *not* explainable from the structured data alone, because it's the one Batch 4's investigate stage will resolve using synthetic evidence (see Batch 4 section) |

Update `ground_truth.json` to explicitly label each of these seeded rows
with the anomaly type and, for the "small unexplained delta" row, the
correct amount that should eventually be found once evidence exists (you'll
add that evidence file in Batch 4, not here — for now just record the fact
that this delta is expected to remain an open exception until Batch 4 runs).

Keep the fixed seed. Regenerating must still be reproducible.

## The matcher (`/src/modules/finance/reconcile/matcher.ts`)

Build the reconciliation chain per order: `SALE → PAYMENT → SETTLEMENT →
BANK_TRANSACTION`. Write this as a **pure function** operating on
already-fetched `normalized_events` for a mission (fetch once, pass arrays
in — don't query per-comparison, that's O(n²) round trips).

**Scoring — use this exact formula, don't invent your own weighting:**

For each pair of events being considered as a link in the chain, compute a
signal score:

```
id_signal:
  - exact external_ref / order_id / customer_id linkage already resolved
    during normalize (i.e. normalized_events.order_id or .payment_id is
    populated and matches the other side) → 100
  - no direct ID linkage → 0

amount_signal (only relevant when id_signal < 100, as a corroborating check
even when id_signal is 100):
  - difference ≤ ₹1 (rounding) → 30
  - difference ≤ 1% of the larger amount → 20
  - difference ≤ 5% of the larger amount → 10
  - otherwise → 0

date_signal:
  - same day → 25
  - within 1–3 days → 20
  - within 4–7 days → 12
  - within 8–14 days → 5
  - beyond 14 days → 0

reference_signal (fuzzy string match — use a Jaro-Winkler or
Levenshtein-ratio library, don't hand-roll one):
  - similarity ≥ 0.9 between e.g. bank `description` and the settlement_id/
    payment_id it should contain → 20
  - similarity ≥ 0.7 → 10
  - below 0.7 → 0
```

**Combined link confidence** = `id_signal + amount_signal + date_signal +
reference_signal`, capped at 100 (don't let it exceed 100 even if multiple
signals stack — cap with `Math.min(100, sum)`).

**Chain confidence** (what gets stored on `finance.matches.confidence`) =
the **minimum** confidence across all links in the chain, not the average —
a chain is only as strong as its weakest link, and averaging would let a
perfect SALE↔PAYMENT link mask a garbage SETTLEMENT↔BANK_TRANSACTION link.

**Thresholds:**
- `≥ 85` → `finance.matches.status = 'auto_matched'`
- `50–84` → `status = 'proposed'` (surfaced to human review later, not
  auto-trusted)
- `< 50` for any expected link → **do not create a match row for that
  link**; instead this becomes exception material (see below)

Store the full per-link breakdown in `matches.signals` jsonb, e.g.:
```json
{
  "sale_to_payment": { "id_signal": 100, "amount_signal": 30, "date_signal": 25, "reference_signal": 0, "total": 100 },
  "payment_to_settlement": { "id_signal": 100, "amount_signal": 20, "date_signal": 25, "reference_signal": 0, "total": 100 },
  "settlement_to_bank": { "id_signal": 0, "amount_signal": 20, "date_signal": 12, "reference_signal": 20, "total": 52 }
}
```

`match_type`: `exact_id` if every link's `id_signal` was 100, otherwise
`amount_date_window` if the deciding signal was amount+date,
`fuzzy_reference` if the deciding signal was the fuzzy string match,
`settlement_chain` as a fallback label if it's a mixed chain that doesn't
cleanly fit the other three.

## Exception detection (`/src/modules/finance/exceptions/detect.ts`)

Run after matching. For every mission, walk the chains and classify gaps:

| Condition | `exception_type` |
|---|---|
| SALE matched to PAYMENT, but no SETTLEMENT link reaches ≥50 confidence | `missing_settlement` |
| PAYMENT matched to SETTLEMENT, but no BANK_TRANSACTION link reaches ≥50 confidence | `missing_bank_credit` |
| Full chain matched, but `bank credit date - settlement date` > 5 days | `timing_difference` |
| Two normalized_events with identical `source_system`, `external_ref`, `amount`, `event_date` | `duplicate` |
| Chain fully link-matched (all ≥50) but `abs(expected_amount - actual_amount)` exceeds ₹1 and is not fully accounted for by an existing `FEE` or `REFUND` event already in the chain | `unexplained_difference` (this is the seeded ₹500 case — it should surface here and stay `status = 'open'` until Batch 4 resolves it) |
| Chain fully matched with amounts explained entirely by a `FEE` event already present | **not an exception** — this is expected behavior, don't create a row |
| Chain fully matched with amounts explained entirely by a `REFUND` event already present | classify as `refund` only if you need a record of it for the close report; otherwise treat as matched and skip — use your judgment here but bias toward *not* creating noise for things that are already fully explained by data you already have |

For each exception, set `expected_amount`, `actual_amount`, `difference`,
and populate `normalized_event_ids` with every event involved in that broken
chain (not just the two that disagree — include the full chain so
Batch 4's investigate stage has full context without re-querying).

Write one `audit.audit_log` entry per reconciliation run:
`action = 'mission.reconciled'`, `after = { matches_created, exceptions_created, by_type }`.

Update `finance_missions.status` to `'needs_review'` once reconciliation +
exception detection finish for a mission.

## FE additions for Batch 3

Extend the existing `/finance` mission view (don't create a new page):
- A **"Reconcile"** button, enabled once mission status is `reconciling`.
  Calls the reconcile endpoint, shows a status log same style as the
  extract/normalize log from before.
- A **Matches table**: chain summary per order (order ref, sale amount,
  matched payment/settlement/bank amounts, overall confidence, status
  badge auto_matched/proposed).
- An **Exceptions table**: `exception_type`, `expected_amount`,
  `actual_amount`, `difference`, `status`. Row click expands to show the
  linked `normalized_event_ids` as a small inline list (reuse the events
  table styling from Batch 2, filtered to just those IDs).

Endpoints needed:
- `POST /api/finance/missions/:id/reconcile`
- `GET /api/finance/missions/:id/matches`
- `GET /api/finance/missions/:id/exceptions`

---

# BATCH 4 — Investigate + Judge (first LLM integration)

This is the first batch that calls an LLM. Build the LLM integration as a
**swappable provider layer** — Gemini today, OpenRouter later, with zero
changes required to `investigate.ts` or `judge.ts` when that swap happens.

## LLM abstraction — build this first, before writing any prompt logic

```
/src/shared/llm
  types.ts        -- provider-agnostic interface + shared types
  gemini.ts        -- Gemini implementation of the interface
  index.ts          -- factory: reads LLM_PROVIDER env var, returns the right implementation
```

**`types.ts`** defines the contract everything else codes against:

```ts
export interface StructuredCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  responseSchema: unknown;      // JSON Schema object, provider-agnostic shape
  temperature?: number;
}

export interface StructuredCompletionResult<T> {
  data: T;
  rawResponse: unknown;          // keep the raw provider response for audit/debugging
  model: string;
  provider: string;
}

export interface LLMProvider {
  name: string;
  generateStructured<T>(req: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>>;
}
```

**`gemini.ts`** implements `LLMProvider` using the Gemini API, converting
the provider-agnostic `responseSchema` into Gemini's `responseSchema` /
`responseMimeType: "application/json"` config. Read `GEMINI_API_KEY` and
model name from env (`GEMINI_MODEL`, default something sensible like
`gemini-2.5-flash` for investigate and allow overriding to a stronger model
for judge via a second env var `GEMINI_JUDGE_MODEL` — investigate and judge
should be allowed to use different models/temperatures even on the same
provider).

**`index.ts`**:
```ts
export function getLLMProvider(purpose: 'investigate' | 'judge'): LLMProvider {
  const providerName = process.env.LLM_PROVIDER ?? 'gemini';
  if (providerName === 'gemini') return new GeminiProvider(purpose);
  throw new Error(`Unknown LLM provider: ${providerName}`);
}
```

Every call site (`investigate.ts`, `judge.ts`) must call
`getLLMProvider('investigate' | 'judge')` and use only the `LLMProvider`
interface — **never import `gemini.ts` directly from a route or a business
logic file.** This is the actual requirement here, not a suggestion: when
OpenRouter support is added later, it should be a new `openrouter.ts` file
implementing the same interface plus one new branch in `index.ts`, with
`investigate.ts`/`judge.ts` untouched.

Use **Zod** to define each call's schema once, and derive both the runtime
validator (to check the LLM's output before trusting it — never assume
`responseSchema` guarantees a valid response, validate it anyway) and the
JSON Schema passed to the provider (`zod-to-json-schema` or similar).

## Synthetic evidence data (new for this batch)

The product needs something to investigate against. We don't have a real
support system, so generate synthetic evidence sources alongside the
existing CSVs:

**`/synthetic-data/support_tickets.json`** — an array of ticket objects:
`{ ticket_ref, customer_email, created_date, subject, body, related_amount }`.
Include at least one ticket that explicitly explains the seeded ₹500
"unexplained delta" from Batch 3 (e.g. a support ticket describing a manual
₹500 refund issued for a damaged item, dated near the relevant order), and
2–3 unrelated/noise tickets so retrieval isn't trivially "there's only one
ticket, obviously it's the answer."

**`/synthetic-data/refund_records.json`** — `{ refund_ref, order_ref, amount, date, reason }`,
same idea — include one that corroborates the support ticket above.

These are not uploaded through the document pipeline (they're not
Understand/Extract material — they represent business communications, not
financial source documents). Load them directly: write a small seed script
`/synthetic-data/seed-evidence.ts` that inserts them as candidate evidence
available for retrieval — store them in a simple new area you already have
room for: don't invent a new schema table for this without asking me first;
instead, for this batch, keep them as flat JSON files read directly by the
retrieval function at query time (no DB table). If retrieval performance or
the shape of this genuinely needs a table, stop and propose it rather than
adding one silently.

## Investigate (`/src/modules/finance/investigate/`)

`retrieval.ts` — **plain code, not the LLM** — given an exception, pulls
candidate evidence:
- Load `support_tickets.json` and `refund_records.json`.
- Filter/rank candidates by proximity to the exception: amount within a
  reasonable tolerance of `difference`, date within ~14 days of the
  relevant `normalized_events`, and if a customer/order can be identified
  from the linked events, prefer tickets referencing the same
  customer_email/order_ref.
- Return the top 5 candidates max — don't hand the LLM your entire evidence
  set, hand it a shortlist it actually has a reason to consider.

`gemini.ts` (or generically `investigate.run.ts`, using the LLM
abstraction — don't name it `gemini.ts` inside this folder, that naming
belongs only inside `/shared/llm/`) — calls `getLLMProvider('investigate')`
with:
- System prompt: explain the reconciliation context, that it's picking
  which (if any) of the candidate evidence items explain the given
  exception, and that it must never invent an amount, date, or explanation
  not grounded in the candidates provided.
- User prompt: the exception's expected/actual/difference amounts, the
  linked normalized_events summary, and the shortlisted candidate evidence
  (with their real IDs).
- Response schema: `{ selected_evidence_refs: string[], reasoning: string }`
  where `selected_evidence_refs` must be a subset of the candidate refs you
  actually sent it — **validate this in code after the call**: reject/drop
  any ref in the response that wasn't in the candidate list sent (this is
  your defense against hallucinated citations, don't rely on the prompt
  alone).
- For each selected candidate, insert a `finance.evidence` row:
  `source_type` (`support_ticket` or `refund_record` based on which file it
  came from), `content` (the ticket body / refund reason), `source_ref`
  (`ticket_ref` / `refund_ref`), `relevance_score` (you can derive this from
  retrieval ranking, or ask the LLM to score it 0–100 as part of the same
  call — your call), `found_by = 'gemini_retrieval'`.
- Update `exceptions.status = 'investigating'`.

## Judge (`/src/modules/finance/judge/`)

Given an exception plus whatever `finance.evidence` rows now exist for it
(from investigate, or manually uploaded ones if that path exists), call
`getLLMProvider('judge')`:
- Response schema: `{ classification: enum(...same 9 values as
  finance.judgment_classification...), confidence: number, explanation: string,
  evidence_ids: string[], recommended_action: string }`.
- **Validate before inserting**: `evidence_ids` must be a subset of actual
  `finance.evidence.id` values that exist for this exception — same
  hallucination guard as investigate. If the LLM returns a classification
  that requires evidence (`MATCHED_WITH_ADJUSTMENT`, `REFUND`, `FEE`,
  `DUPLICATE` — this mirrors the DB CHECK constraint on
  `exception_judgments`) but provides zero valid evidence_ids, **do not
  insert the row** — instead downgrade the classification to
  `REQUIRES_HUMAN_REVIEW` and note in the explanation that evidence was
  insufficient. This keeps you from ever hitting the DB constraint
  violation at runtime — handle it in application logic, not by letting
  Postgres reject the insert.
- Insert into `finance.exception_judgments` (append-only, as the schema
  already enforces — don't upsert, insert a new row each judge run).
- Update `exceptions.status = 'explained'` if classification isn't
  `UNEXPLAINED`/`REQUIRES_HUMAN_REVIEW`, otherwise leave/set
  `requires_human_review`.

Write audit log entries for both investigate and judge runs, including
`actor_type = 'gemini'`, `actor_id = <model name used>`.

## The killer interaction: "Explain this difference"

One endpoint that chains investigate → judge for a single exception on
demand, since this is the single most important interaction in the whole
product (per the product doc, section 18):

`POST /api/finance/exceptions/:exceptionId/explain`

Runs retrieval → investigate LLM call → judge LLM call → returns the final
judgment with evidence attached, all in one request/response so the FE can
show a single loading state and then the full explanation.

## FE additions for Batch 4

On the Exceptions table (from Batch 3), each row gets an **"Explain this
difference"** button. Clicking it:
1. Calls the `/explain` endpoint, shows a loading state.
2. Renders the result as a small card: classification badge, confidence %,
   explanation text, list of cited evidence (source type + content
   snippet + source_ref), recommended action.
3. This card should visually resemble the example in the product doc
   (section 18) — original amount, adjustment, expected vs actual net,
   evidence list, confidence — since this is the moment meant to sell the
   product to a judge/demo audience. Make it look deliberate, not like a
   raw JSON dump, even though the rest of this build has been intentionally
   utilitarian.

---

## Folder structure additions (extends Batch 2's structure, doesn't replace it)

```
/src
  /modules/finance
    /reconcile
      matcher.ts
      run.ts
      routes.ts
    /exceptions
      detect.ts
      routes.ts
    /investigate
      retrieval.ts
      run.ts            -- calls the LLM abstraction, not "gemini.ts"
      routes.ts
    /judge
      classify.ts        -- calls the LLM abstraction
      routes.ts
  /shared
    /llm
      types.ts
      gemini.ts
      index.ts
/synthetic-data
  support_tickets.json
  refund_records.json
  seed-evidence.ts
```

## Non-negotiable rules (same as before, plus new ones for this pair of batches)

- No arithmetic decision (what a number *is*) ever comes from the LLM —
  only from `matcher.ts`, `detect.ts`, and Postgres. The LLM only decides
  *which evidence explains* a number and *how to classify* an already-
  computed exception.
- Every LLM call site goes through `/shared/llm`, never a direct provider
  SDK import elsewhere.
- Every LLM output is validated against the candidates/evidence actually
  available before being trusted or inserted — no exceptions to this, it's
  the single most important rule in this batch.
- No new tables without asking first — evidence for this batch stays as
  flat JSON files read at query time, not a new schema table.
- No "batch" naming anywhere in code, routes, or UI — see the correction at
  the top of this document.

## Acceptance criteria

1. Re-running `synthetic-data/generate.ts` produces the same seeded
   anomalies deterministically, and `ground_truth.json` documents each one.
2. Clicking "Reconcile" on a mission produces a Matches table where the
   ~40 clean chains show `auto_matched` with confidence ≥ 85, and the 5
   seeded anomalies each surface as the correct `exception_type`.
3. Clicking "Explain this difference" on the seeded ₹500 unexplained-delta
   exception returns a judgment citing the planted support ticket, with a
   classification other than `UNEXPLAINED`.
4. Clicking "Explain this difference" on a genuinely unrelated/noise
   exception (if you seed one with no real explanation available)
   correctly returns `REQUIRES_HUMAN_REVIEW` or `UNEXPLAINED` rather than
   fabricating a cause — this is the test that actually matters, since a
   demo where the LLM invents a plausible-sounding lie is worse than no
   demo at all.
5. Setting `LLM_PROVIDER=openrouter` in `.env` without that provider yet
   implemented throws a clear "Unknown LLM provider" error at startup or
   first call, not a silent fallback to Gemini — proves the abstraction
   boundary is real, not cosmetic.
6. `audit.audit_log` has rows for every reconcile run, every investigate
   call, every judge call, tagged with the correct `actor_type`.

If anything here conflicts with what's already in the DB from your Batch 2
test run, tell me — don't silently wipe or reset mission data to make it
fit.