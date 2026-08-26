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

-- 4. Optional Additive Columns on normalized_events for high-performance querying
ALTER TABLE finance.normalized_events ADD COLUMN IF NOT EXISTS batch_ref text;
ALTER TABLE finance.normalized_events ADD COLUMN IF NOT EXISTS order_ids text[];
ALTER TABLE finance.normalized_events ADD COLUMN IF NOT EXISTS deduction_type text;
