-- Migration: Amazon Seller Central Flat File V2 settlement support.
-- The report is a tab-delimited 24-column export even when downloaded as .csv.

ALTER TYPE finance.detected_source ADD VALUE IF NOT EXISTS 'amazon_settlement';
ALTER TYPE finance.source_system ADD VALUE IF NOT EXISTS 'amazon';
ALTER TYPE finance.exception_type ADD VALUE IF NOT EXISTS 'amazon_unknown_deduction';
ALTER TYPE finance.exception_type ADD VALUE IF NOT EXISTS 'amazon_return_clawback';
ALTER TYPE finance.exception_type ADD VALUE IF NOT EXISTS 'amazon_fee_anomaly';
ALTER TYPE finance.evidence_source_type ADD VALUE IF NOT EXISTS 'amazon_settlement';
