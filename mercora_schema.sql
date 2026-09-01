-- ============================================================================
-- MERCORA — Merchant Brain (core) + Finance Agent (finance) + Audit
-- ============================================================================
-- Design rules this file follows (do not violate these when extending):
--   1. core.* holds entities every future agent (Growth/CRM/Finance/Website)
--      will reference. Keep it minimal — only what's actually shared.
--   2. finance.* is owned by the Finance Agent pipeline. It references
--      core.* by FK where a real link exists, and stands alone (merchant_id
--      only) when it doesn't (e.g. a vendor invoice with no matching order).
--   3. audit.* is shared by every agent — one audit log, not one per domain.
--   4. Money is NUMERIC, never FLOAT. Currency is always stored alongside amount.
--   5. Every domain table carries merchant_id directly (not just via joins)
--      so RLS and scoped queries stay cheap and simple.
--   6. Nothing in finance.* computes truth — LLM outputs land in
--      exception_judgments.explanation as TEXT, never as a number that feeds
--      close_reports. close_reports.summary is built by SQL aggregation only.
-- ============================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

create schema if not exists core;
create schema if not exists finance;
create schema if not exists audit;

-- ============================================================================
-- SHARED HELPER: updated_at trigger
-- ============================================================================

create or replace function core.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- CORE — shared across all future agents (Growth / CRM / Finance / Website)
-- ============================================================================

create table core.merchants (
  id              uuid primary key default gen_random_uuid(),
  auth_user_id    uuid not null references auth.users(id) on delete cascade,
  business_name   text not null,
  default_currency text not null default 'INR',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index merchants_auth_user_id_idx on core.merchants(auth_user_id);

create trigger merchants_set_updated_at
  before update on core.merchants
  for each row execute function core.set_updated_at();

-- ----------------------------------------------------------------------------

create table core.customers (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references core.merchants(id) on delete cascade,
  external_ref  text,                 -- e.g. Shopify customer id
  name          text,
  email         text,
  phone         text,
  created_at    timestamptz not null default now(),
  unique (merchant_id, external_ref)
);

create index customers_merchant_id_idx on core.customers(merchant_id);

-- ----------------------------------------------------------------------------

create table core.products (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references core.merchants(id) on delete cascade,
  external_ref  text,                 -- e.g. Shopify product/variant id
  sku           text,
  name          text,
  price         numeric(14,2),
  margin_pct    numeric(6,3),
  created_at    timestamptz not null default now(),
  unique (merchant_id, external_ref)
);

create index products_merchant_id_idx on core.products(merchant_id);

-- ----------------------------------------------------------------------------

create table core.orders (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references core.merchants(id) on delete cascade,
  customer_id   uuid references core.customers(id) on delete set null,
  external_ref  text not null,        -- Shopify order id
  order_number  text,
  total_amount  numeric(14,2) not null,
  currency      text not null default 'INR',
  status        text,                 -- fulfilled / refunded / cancelled / ...
  order_date    date not null,
  created_at    timestamptz not null default now(),
  unique (merchant_id, external_ref)
);

create index orders_merchant_id_idx on core.orders(merchant_id);
create index orders_customer_id_idx on core.orders(customer_id);
create index orders_order_date_idx on core.orders(order_date);

-- ----------------------------------------------------------------------------

create table core.payments (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references core.merchants(id) on delete cascade,
  order_id      uuid references core.orders(id) on delete set null,
  external_ref  text not null,        -- Razorpay payment id (pay_xxx)
  amount        numeric(14,2) not null,
  currency      text not null default 'INR',
  status        text,
  payment_date  date not null,
  created_at    timestamptz not null default now(),
  unique (merchant_id, external_ref)
);

create index payments_merchant_id_idx on core.payments(merchant_id);
create index payments_order_id_idx on core.payments(order_id);

-- ============================================================================
-- FINANCE — Finance Agent domain (reconciliation, investigation, close)
-- ============================================================================

create type finance.mission_status as enum (
  'created', 'ingesting', 'reconciling', 'needs_review', 'closed'
);

create type finance.detected_source as enum (
  'shopify_orders', 'amazon_orders', 'razorpay_settlement', 'amazon_settlement', 'bank_statement',
  'generic_cod', 'courier_settlement',
  'vendor_invoice', 'support_export', 'unknown'
);

create type finance.detection_method as enum (
  'filename_heuristic', 'gemini_classified', 'user_corrected'
);

create type finance.extraction_method as enum (
  'csv_parse', 'gemini_vision', 'gemini_text', 'manual'
);

create type finance.event_type as enum (
  'SALE', 'PAYMENT', 'REFUND', 'FEE', 'SETTLEMENT', 'BANK_TRANSACTION',
  'BANK_CREDIT',
  'INVOICE', 'PURCHASE', 'ADJUSTMENT', 'CHARGEBACK', 'CREDIT_NOTE', 'DEBIT_NOTE',
  'COD_COLLECTION', 'COD_REMITTANCE', 'COD_DEDUCTION', 'RTO_EVENT'
);

create type finance.source_system as enum (
  'shopify', 'razorpay', 'amazon', 'bank', 'courier', 'cod', 'vendor', 'manual'
);

create type finance.match_type as enum (
  'exact_id', 'amount_date_window', 'fuzzy_reference', 'settlement_chain'
);

create type finance.match_status as enum (
  'auto_matched', 'proposed', 'confirmed', 'rejected'
);

create type finance.exception_type as enum (
  'timing_difference', 'gateway_fee', 'refund', 'partial_refund',
  'duplicate', 'missing_settlement', 'missing_bank_credit', 'ambiguous_bank_credit',
  'unexplained_difference', 'amazon_unknown_deduction', 'amazon_return_clawback',
  'amazon_fee_anomaly'
);

create type finance.exception_status as enum (
  'open', 'investigating', 'explained', 'requires_human_review', 'resolved'
);

create type finance.evidence_source_type as enum (
  'support_ticket', 'refund_record', 'manual_note', 'invoice', 'email', 'amazon_settlement'
);

create type finance.evidence_found_by as enum (
  'gemini_retrieval', 'manual_upload'
);

create type finance.judgment_classification as enum (
  'MATCHED', 'MATCHED_WITH_ADJUSTMENT', 'TIMING_DIFFERENCE', 'FEE', 'REFUND',
  'DUPLICATE', 'MISSING_RECORD', 'UNEXPLAINED', 'REQUIRES_HUMAN_REVIEW'
);

create type finance.review_action as enum (
  'confirmed', 'rejected', 'explained_manually', 'requested_investigation', 'resolved'
);

-- ----------------------------------------------------------------------------

create table finance.finance_missions (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references core.merchants(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  sources       jsonb not null default '[]'::jsonb, -- ["shopify","razorpay","hdfc_bank"]
  objective     text,                                -- free-text mission goal
  status        finance.mission_status not null default 'created',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (period_end >= period_start)
);

create index finance_missions_merchant_id_idx on finance.finance_missions(merchant_id);

create trigger finance_missions_set_updated_at
  before update on finance.finance_missions
  for each row execute function core.set_updated_at();

-- ----------------------------------------------------------------------------

create table finance.source_documents (
  id                    uuid primary key default gen_random_uuid(),
  mission_id            uuid not null references finance.finance_missions(id) on delete cascade,
  merchant_id           uuid not null references core.merchants(id) on delete cascade,
  file_path             text not null,      -- supabase storage path
  original_filename     text not null,
  mime_type             text,
  detected_source       finance.detected_source not null default 'unknown',
  detection_method      finance.detection_method not null default 'filename_heuristic',
  detection_confidence  numeric(5,2),        -- 0-100
  uploaded_at           timestamptz not null default now()
);

create index source_documents_mission_id_idx on finance.source_documents(mission_id);

-- ----------------------------------------------------------------------------

create table finance.extracted_records (
  id                    uuid primary key default gen_random_uuid(),
  source_document_id    uuid not null references finance.source_documents(id) on delete cascade,
  mission_id            uuid not null references finance.finance_missions(id) on delete cascade,
  merchant_id           uuid not null references core.merchants(id) on delete cascade,
  raw_json              jsonb not null,      -- exactly what extraction produced, untouched
  extraction_method     finance.extraction_method not null,
  extraction_confidence numeric(5,2),        -- 0-100, meaningful mainly for gemini_vision/text
  created_at            timestamptz not null default now()
);

create index extracted_records_mission_id_idx on finance.extracted_records(mission_id);
create index extracted_records_source_document_id_idx on finance.extracted_records(source_document_id);

-- ----------------------------------------------------------------------------
-- The canonical layer. Every downstream stage (reconcile/exceptions/close)
-- reads from here, never from extracted_records or source_documents directly.
-- ----------------------------------------------------------------------------

create table finance.normalized_events (
  id                    uuid primary key default gen_random_uuid(),
  mission_id            uuid not null references finance.finance_missions(id) on delete cascade,
  merchant_id           uuid not null references core.merchants(id) on delete cascade,
  extracted_record_id   uuid not null references finance.extracted_records(id) on delete restrict,

  event_type            finance.event_type not null,
  source_system         finance.source_system not null,
  external_ref          text,                -- order id / payment id / settlement id / txn id
  amount                numeric(14,2) not null,
  currency              text not null default 'INR',
  event_date            date not null,
  counterparty          text,                -- customer name/id, vendor name

  -- soft links back into core.* where a real match exists; nullable because
  -- e.g. a vendor invoice or bank fee line has no corresponding core.order
  order_id              uuid references core.orders(id) on delete set null,
  payment_id            uuid references core.payments(id) on delete set null,
  customer_id           uuid references core.customers(id) on delete set null,

  -- COD batch and line-item fields
  batch_ref             text,
  order_ids             text[],
  deduction_type        text,

  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create index normalized_events_mission_id_idx on finance.normalized_events(mission_id);
create index normalized_events_merchant_id_idx on finance.normalized_events(merchant_id);
create index normalized_events_event_type_idx on finance.normalized_events(event_type);
create index normalized_events_external_ref_idx on finance.normalized_events(external_ref);
create index normalized_events_event_date_idx on finance.normalized_events(event_date);
create index normalized_events_amount_idx on finance.normalized_events(amount);

-- ----------------------------------------------------------------------------

create table finance.matches (
  id            uuid primary key default gen_random_uuid(),
  mission_id    uuid not null references finance.finance_missions(id) on delete cascade,
  event_ids     uuid[] not null,     -- SALE + PAYMENT + SETTLEMENT + BANK_TRANSACTION chain
  match_type    finance.match_type not null,
  confidence    numeric(5,2) not null,   -- 0-100, computed by the deterministic matcher
  signals       jsonb not null default '{}'::jsonb, -- {"id_match":true,"amount_diff":0,"date_diff_days":2}
  status        finance.match_status not null default 'proposed',
  created_at    timestamptz not null default now(),
  check (array_length(event_ids, 1) >= 2)
);

create index matches_mission_id_idx on finance.matches(mission_id);
create index matches_event_ids_idx on finance.matches using gin(event_ids);

-- Ranked deterministic candidates are retained so LLM fallback and later
-- threshold tuning consume structured evidence rather than raw narrations.
create table finance.bank_credit_candidates (
  id                    uuid primary key default gen_random_uuid(),
  mission_id            uuid not null references finance.finance_missions(id) on delete cascade,
  bank_credit_id        uuid not null references finance.normalized_events(id) on delete cascade,
  candidate_event_id    uuid not null references finance.normalized_events(id) on delete cascade,
  batch_ref             text not null,
  source                text not null,
  score                 numeric(5,2) not null,
  amount                numeric(14,2) not null,
  event_date            date not null,
  signals               jsonb not null default '{}'::jsonb,
  resolution_status     text not null default 'ambiguous',
  created_at            timestamptz not null default now(),
  unique (bank_credit_id, candidate_event_id)
);

create index bank_credit_candidates_mission_id_idx on finance.bank_credit_candidates(mission_id);
create index bank_credit_candidates_bank_credit_id_idx on finance.bank_credit_candidates(bank_credit_id);

-- ----------------------------------------------------------------------------

create table finance.exceptions (
  id                    uuid primary key default gen_random_uuid(),
  mission_id            uuid not null references finance.finance_missions(id) on delete cascade,
  normalized_event_ids  uuid[] not null,
  exception_type        finance.exception_type not null,
  expected_amount       numeric(14,2),
  actual_amount         numeric(14,2),
  difference            numeric(14,2),
  status                finance.exception_status not null default 'open',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index exceptions_mission_id_idx on finance.exceptions(mission_id);
create index exceptions_status_idx on finance.exceptions(status);
create index exceptions_event_ids_idx on finance.exceptions using gin(normalized_event_ids);

create trigger exceptions_set_updated_at
  before update on finance.exceptions
  for each row execute function core.set_updated_at();

-- ----------------------------------------------------------------------------

create table finance.evidence (
  id                uuid primary key default gen_random_uuid(),
  exception_id      uuid not null references finance.exceptions(id) on delete cascade,
  source_type       finance.evidence_source_type not null,
  content           text not null,
  source_ref        text,           -- e.g. "Support #1829", "RF-293"
  relevance_score   numeric(5,2),   -- 0-100
  found_by          finance.evidence_found_by not null default 'gemini_retrieval',
  created_at        timestamptz not null default now()
);

create index evidence_exception_id_idx on finance.evidence(exception_id);

-- ----------------------------------------------------------------------------
-- One row per Judge run. Kept append-only (no updated_at) so re-judging an
-- exception after new evidence arrives preserves history instead of overwriting it.
-- ----------------------------------------------------------------------------

create table finance.exception_judgments (
  id                  uuid primary key default gen_random_uuid(),
  exception_id        uuid not null references finance.exceptions(id) on delete cascade,
  classification      finance.judgment_classification not null,
  confidence          numeric(5,2) not null,   -- 0-100
  explanation         text not null,           -- Gemini-generated; must reference evidence_ids
  evidence_ids        uuid[] not null default '{}',
  recommended_action  text,
  generated_at        timestamptz not null default now(),
  -- structural enforcement of "never treat an LLM explanation as financial truth":
  -- any classification implying a known cause must cite at least one evidence row
  check (
    classification not in ('MATCHED_WITH_ADJUSTMENT', 'REFUND', 'FEE', 'DUPLICATE')
    or array_length(evidence_ids, 1) >= 1
  )
);

create index exception_judgments_exception_id_idx on finance.exception_judgments(exception_id);

-- ----------------------------------------------------------------------------

create table finance.human_reviews (
  id            uuid primary key default gen_random_uuid(),
  exception_id  uuid not null references finance.exceptions(id) on delete cascade,
  reviewer_id   uuid not null references auth.users(id),
  action        finance.review_action not null,
  note          text,
  decided_at    timestamptz not null default now()
);

create index human_reviews_exception_id_idx on finance.human_reviews(exception_id);

-- ----------------------------------------------------------------------------

create table finance.close_reports (
  id            uuid primary key default gen_random_uuid(),
  mission_id    uuid not null references finance.finance_missions(id) on delete cascade,
  summary       jsonb not null,     -- computed via SQL aggregation, never LLM arithmetic
  generated_at  timestamptz not null default now()
);

create index close_reports_mission_id_idx on finance.close_reports(mission_id);

-- ============================================================================
-- AUDIT — shared across every agent, not just Finance
-- ============================================================================

create type audit.actor_type as enum ('system', 'gemini', 'user');

create table audit.audit_log (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references core.merchants(id) on delete cascade,
  mission_id    uuid,               -- nullable, not FK-constrained: audit log must outlive any single domain
  actor_type    audit.actor_type not null,
  actor_id      text,               -- auth.users.id as text for 'user', model name for 'gemini', null for 'system'
  action        text not null,      -- e.g. "match.confirmed", "exception.judged", "mission.closed"
  entity_type   text not null,      -- e.g. "finance.matches"
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  created_at    timestamptz not null default now()
);

create index audit_log_merchant_id_idx on audit.audit_log(merchant_id);
create index audit_log_mission_id_idx on audit.audit_log(mission_id);
create index audit_log_entity_idx on audit.audit_log(entity_type, entity_id);

-- ============================================================================
-- ROW LEVEL SECURITY
-- Every merchant-scoped table is locked to rows owned by the authenticated
-- user via core.merchants.auth_user_id. Service-role calls (your Express
-- backend, if it uses the service key) bypass RLS entirely, which is expected
-- — RLS here protects any direct client/browser access via the Supabase anon key.
-- ============================================================================

create or replace function core.owns_merchant(target_merchant_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from core.merchants m
    where m.id = target_merchant_id
      and m.auth_user_id = auth.uid()
  );
$$;

alter table core.merchants enable row level security;
alter table core.customers enable row level security;
alter table core.products enable row level security;
alter table core.orders enable row level security;
alter table core.payments enable row level security;

alter table finance.finance_missions enable row level security;
alter table finance.source_documents enable row level security;
alter table finance.extracted_records enable row level security;
alter table finance.normalized_events enable row level security;
alter table finance.matches enable row level security;
alter table finance.bank_credit_candidates enable row level security;
alter table finance.exceptions enable row level security;
alter table finance.evidence enable row level security;
alter table finance.exception_judgments enable row level security;
alter table finance.human_reviews enable row level security;
alter table finance.close_reports enable row level security;

alter table audit.audit_log enable row level security;

create policy merchants_owner_all on core.merchants
  for all using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());

create policy customers_owner_all on core.customers
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

create policy products_owner_all on core.products
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

create policy orders_owner_all on core.orders
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

create policy payments_owner_all on core.payments
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

create policy finance_missions_owner_all on finance.finance_missions
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

create policy source_documents_owner_all on finance.source_documents
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

create policy extracted_records_owner_all on finance.extracted_records
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

create policy normalized_events_owner_all on finance.normalized_events
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

-- matches/exceptions/evidence/judgments/human_reviews/close_reports don't carry
-- merchant_id directly (by design — they hang off mission_id) so scope via the
-- parent mission's merchant_id.

create policy matches_owner_all on finance.matches
  for all using (
    exists (select 1 from finance.finance_missions fm
            where fm.id = matches.mission_id and core.owns_merchant(fm.merchant_id))
  ) with check (
    exists (select 1 from finance.finance_missions fm
            where fm.id = matches.mission_id and core.owns_merchant(fm.merchant_id))
  );

create policy bank_credit_candidates_owner_all on finance.bank_credit_candidates
  for all using (
    exists (select 1 from finance.finance_missions fm
            where fm.id = bank_credit_candidates.mission_id and core.owns_merchant(fm.merchant_id))
  ) with check (
    exists (select 1 from finance.finance_missions fm
            where fm.id = bank_credit_candidates.mission_id and core.owns_merchant(fm.merchant_id))
  );

create policy exceptions_owner_all on finance.exceptions
  for all using (
    exists (select 1 from finance.finance_missions fm
            where fm.id = exceptions.mission_id and core.owns_merchant(fm.merchant_id))
  ) with check (
    exists (select 1 from finance.finance_missions fm
            where fm.id = exceptions.mission_id and core.owns_merchant(fm.merchant_id))
  );

create policy evidence_owner_all on finance.evidence
  for all using (
    exists (select 1 from finance.exceptions ex
            join finance.finance_missions fm on fm.id = ex.mission_id
            where ex.id = evidence.exception_id and core.owns_merchant(fm.merchant_id))
  ) with check (
    exists (select 1 from finance.exceptions ex
            join finance.finance_missions fm on fm.id = ex.mission_id
            where ex.id = evidence.exception_id and core.owns_merchant(fm.merchant_id))
  );

create policy exception_judgments_owner_all on finance.exception_judgments
  for all using (
    exists (select 1 from finance.exceptions ex
            join finance.finance_missions fm on fm.id = ex.mission_id
            where ex.id = exception_judgments.exception_id and core.owns_merchant(fm.merchant_id))
  ) with check (
    exists (select 1 from finance.exceptions ex
            join finance.finance_missions fm on fm.id = ex.mission_id
            where ex.id = exception_judgments.exception_id and core.owns_merchant(fm.merchant_id))
  );

create policy human_reviews_owner_all on finance.human_reviews
  for all using (
    exists (select 1 from finance.exceptions ex
            join finance.finance_missions fm on fm.id = ex.mission_id
            where ex.id = human_reviews.exception_id and core.owns_merchant(fm.merchant_id))
  ) with check (
    exists (select 1 from finance.exceptions ex
            join finance.finance_missions fm on fm.id = ex.mission_id
            where ex.id = human_reviews.exception_id and core.owns_merchant(fm.merchant_id))
  );

create policy close_reports_owner_all on finance.close_reports
  for all using (
    exists (select 1 from finance.finance_missions fm
            where fm.id = close_reports.mission_id and core.owns_merchant(fm.merchant_id))
  ) with check (
    exists (select 1 from finance.finance_missions fm
            where fm.id = close_reports.mission_id and core.owns_merchant(fm.merchant_id))
  );

create policy audit_log_owner_all on audit.audit_log
  for all using (core.owns_merchant(merchant_id)) with check (core.owns_merchant(merchant_id));

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
