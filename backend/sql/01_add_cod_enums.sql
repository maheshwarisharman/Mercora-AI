-- Migration: Add COD (Cash-on-Delivery) enum values to PostgreSQL types
-- Run this in Supabase SQL Editor to enable native PostgreSQL enum support for COD

-- 1. Detected Sources
ALTER TYPE finance.detected_source ADD VALUE IF NOT EXISTS 'generic_cod';
ALTER TYPE finance.detected_source ADD VALUE IF NOT EXISTS 'courier_settlement';

-- 2. Source Systems
ALTER TYPE finance.source_system ADD VALUE IF NOT EXISTS 'courier';
ALTER TYPE finance.source_system ADD VALUE IF NOT EXISTS 'cod';

-- 3. Event Types
ALTER TYPE finance.event_type ADD VALUE IF NOT EXISTS 'COD_COLLECTION';
ALTER TYPE finance.event_type ADD VALUE IF NOT EXISTS 'COD_REMITTANCE';
ALTER TYPE finance.event_type ADD VALUE IF NOT EXISTS 'COD_DEDUCTION';
ALTER TYPE finance.event_type ADD VALUE IF NOT EXISTS 'RTO_EVENT';
ALTER TYPE finance.event_type ADD VALUE IF NOT EXISTS 'BANK_CREDIT';

-- 5. Ambiguous bank-credit exceptions
ALTER TYPE finance.exception_type ADD VALUE IF NOT EXISTS 'ambiguous_bank_credit';

-- 4. Optional Additive Columns on normalized_events for high-performance querying
ALTER TABLE finance.normalized_events ADD COLUMN IF NOT EXISTS batch_ref text;
ALTER TABLE finance.normalized_events ADD COLUMN IF NOT EXISTS order_ids text[];
ALTER TABLE finance.normalized_events ADD COLUMN IF NOT EXISTS deduction_type text;

CREATE TABLE IF NOT EXISTS finance.bank_credit_candidates (
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

CREATE INDEX IF NOT EXISTS bank_credit_candidates_mission_id_idx ON finance.bank_credit_candidates(mission_id);
CREATE INDEX IF NOT EXISTS bank_credit_candidates_bank_credit_id_idx ON finance.bank_credit_candidates(bank_credit_id);

ALTER TABLE finance.bank_credit_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_credit_candidates_owner_all ON finance.bank_credit_candidates;
CREATE POLICY bank_credit_candidates_owner_all ON finance.bank_credit_candidates
  FOR ALL USING (
    EXISTS (SELECT 1 FROM finance.finance_missions fm
            WHERE fm.id = bank_credit_candidates.mission_id AND core.owns_merchant(fm.merchant_id))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM finance.finance_missions fm
            WHERE fm.id = bank_credit_candidates.mission_id AND core.owns_merchant(fm.merchant_id))
  );
