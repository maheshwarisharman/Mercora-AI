-- Migration: Add amazon_orders to the finance.detected_source enum
-- Run this in Supabase SQL Editor or via migration tooling.

ALTER TYPE finance.detected_source ADD VALUE IF NOT EXISTS 'amazon_orders';
