// Mercora Finance Module Shared Types
// Mirroring mercora_schema.sql strictly

/**
 * Safely parses any date string / timestamp into Postgres YYYY-MM-DD format.
 * Never returns an empty string "", preventing PostgreSQL code 22007 invalid input syntax for date.
 */
export function parseDateToIso(dateVal?: any, fallbackDate?: string): string {
  const fallback = fallbackDate || new Date().toISOString().split("T")[0];
  if (!dateVal || typeof dateVal !== "string" || !dateVal.trim()) {
    return fallback;
  }
  const clean = dateVal.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean;
  }

  if (clean.includes("T") || clean.includes(" ")) {
    const firstPart = clean.split(/[T ]/)[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstPart)) {
      return firstPart;
    }
  }

  if (/^\d{2}[/-]\d{2}[/-]\d{4}$/.test(clean)) {
    const parts = clean.split(/[/-]/);
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  if (/^\d{4}\/\d{2}\/\d{2}$/.test(clean)) {
    return clean.replace(/\//g, "-");
  }

  const d = new Date(clean);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split("T")[0];
  }

  return fallback;
}

export type MissionStatus =
  | 'created'
  | 'ingesting'
  | 'reconciling'
  | 'needs_review'
  | 'closed';

export type DetectedSource =
  | 'shopify_orders'
  | 'razorpay_settlement'
  | 'bank_statement'
  | 'generic_cod'
  | 'courier_settlement'
  | 'vendor_invoice'
  | 'support_export'
  | 'unknown';

export type DetectionMethod =
  | 'filename_heuristic'
  | 'gemini_classified'
  | 'user_corrected';

export type ExtractionMethod =
  | 'csv_parse'
  | 'gemini_vision'
  | 'gemini_text'
  | 'manual';

export type EventType =
  | 'SALE'
  | 'PAYMENT'
  | 'REFUND'
  | 'FEE'
  | 'SETTLEMENT'
  | 'BANK_TRANSACTION'
  | 'BANK_CREDIT'
  | 'INVOICE'
  | 'PURCHASE'
  | 'ADJUSTMENT'
  | 'CHARGEBACK'
  | 'CREDIT_NOTE'
  | 'DEBIT_NOTE'
  | 'COD_COLLECTION'
  | 'COD_REMITTANCE'
  | 'COD_DEDUCTION'
  | 'RTO_EVENT';

export type DeductionType =
  | 'HANDLING_FEE'
  | 'RTO_CLAWBACK'
  | 'WEIGHT_ADJ'
  | 'SHORTPAY'
  | 'FREIGHT_CHARGE'
  | 'OTHER';

export type SourceSystem =
  | 'shopify'
  | 'razorpay'
  | 'bank'
  | 'courier'
  | 'cod'
  | 'vendor'
  | 'manual';

export type ActorType = 'system' | 'gemini' | 'user';

// Core Schema Entities
export interface CoreMerchant {
  id: string;
  auth_user_id: string;
  business_name: string;
  default_currency: string;
  created_at: string;
  updated_at: string;
}

export interface CoreCustomer {
  id: string;
  merchant_id: string;
  external_ref?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  created_at: string;
}

export interface CoreOrder {
  id: string;
  merchant_id: string;
  customer_id?: string | null;
  external_ref: string;
  order_number?: string | null;
  total_amount: number;
  currency: string;
  status?: string | null;
  order_date: string;
  created_at: string;
}

export interface CorePayment {
  id: string;
  merchant_id: string;
  order_id?: string | null;
  external_ref: string;
  amount: number;
  currency: string;
  status?: string | null;
  payment_date: string;
  created_at: string;
}

// Finance Schema Entities
export interface FinanceMission {
  id: string;
  merchant_id: string;
  period_start: string;
  period_end: string;
  sources: string[];
  objective?: string | null;
  status: MissionStatus;
  created_at: string;
  updated_at: string;
}

export interface SourceDocument {
  id: string;
  mission_id: string;
  merchant_id: string;
  file_path: string;
  original_filename: string;
  mime_type?: string | null;
  detected_source: DetectedSource;
  detection_method: DetectionMethod;
  detection_confidence?: number | null;
  uploaded_at: string;
}

export interface ExtractedRecord {
  id: string;
  source_document_id: string;
  mission_id: string;
  merchant_id: string;
  raw_json: Record<string, any>;
  extraction_method: ExtractionMethod;
  extraction_confidence?: number | null;
  created_at: string;
}

export interface NormalizedEvent {
  id?: string;
  mission_id: string;
  merchant_id: string;
  extracted_record_id: string;
  event_type: EventType;
  source_system: SourceSystem;
  external_ref?: string | null;
  amount: number;
  currency?: string;
  event_date: string;
  counterparty?: string | null;
  order_id?: string | null;
  payment_id?: string | null;
  customer_id?: string | null;
  batch_ref?: string | null;
  order_ids?: string[] | null;
  deduction_type?: DeductionType | string | null;
  metadata?: Record<string, any>;
  created_at?: string;
}

// Audit Log Entity
export interface AuditLogEntry {
  id?: string;
  merchant_id: string;
  mission_id?: string | null;
  actor_type: ActorType;
  actor_id?: string | null;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
  created_at?: string;
}
