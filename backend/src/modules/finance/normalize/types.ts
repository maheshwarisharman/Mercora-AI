import type { SupabaseClient } from "@supabase/supabase-js";
import type { DetectedSource, ExtractedRecord, NormalizedEvent } from "../shared/types";

export interface NormalizationContext {
  missionId: string;
  merchantId: string;
  supabase: SupabaseClient;
}

export interface ValidationResult {
  valid: boolean;
  missingFields?: string[];
  recordIssues?: Array<{ recordId: string; missingFields: string[] }>;
}

/**
 * Common adapter interface for all financial data source normalizers.
 */
export interface SourceNormalizerAdapter {
  /**
   * Matches detected_source from the understand/classify step.
   */
  readonly detectedSource: DetectedSource | string;

  /**
   * Field names required in extracted records for this source.
   */
  readonly requiredFields: string[];

  /**
   * Execution priority for sequencing normalizations:
   * e.g., 1: shopify_orders, 2: razorpay_settlement, 3: cod/courier, 4: bank_statement
   */
  readonly priority: number;

  /**
   * Validates extracted records against required fields.
   */
  validate?(records: ExtractedRecord[]): ValidationResult;

  /**
   * Normalizes raw extracted records into standardized NormalizedEvent items.
   * Performs any necessary Core entity upserts (e.g., customers, orders, payments).
   */
  normalize(records: ExtractedRecord[], context: NormalizationContext): Promise<NormalizedEvent[]>;
}
