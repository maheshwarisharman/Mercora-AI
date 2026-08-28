import { parseDateToIso } from "../shared/types";

/**
 * Amazon Seller Central's current settlement export is the tab-delimited
 * Flat File V2. These are the 24 columns documented by SP-API and observed
 * in real Seller Central exports. Amazon does not publish an exhaustive
 * amount-description enum, so unknown values are deliberately preserved.
 */
export const AMAZON_FLAT_FILE_V2_HEADERS = [
  "settlement-id",
  "settlement-start-date",
  "settlement-end-date",
  "deposit-date",
  "total-amount",
  "currency",
  "transaction-type",
  "order-id",
  "merchant-order-id",
  "adjustment-id",
  "shipment-id",
  "marketplace-name",
  "amount-type",
  "amount-description",
  "amount",
  "fulfillment-id",
  "posted-date",
  "posted-date-time",
  "order-item-code",
  "merchant-order-item-id",
  "merchant-adjustment-item-id",
  "sku",
  "quantity-purchased",
  "promotion-id",
] as const;

export type AmazonDeductionCategory =
  | "sale_proceeds"
  | "referral_fee"
  | "closing_fee"
  | "fulfillment_fee"
  | "weight_handling_fee"
  | "shipping_fee"
  | "storage_fee"
  | "return_processing_charge"
  | "promotional_rebate"
  | "statutory_tax_withholding"
  | "reserve_or_balance"
  | "tax_or_marketplace_fee"
  | "adjustment"
  | "unrecognized_deduction";

export interface AmazonLineClassification {
  category: AmazonDeductionCategory;
  label: string;
  isDeduction: boolean;
  isStatutoryWithholding: boolean;
  requiresAgent: boolean;
  reason: string;
}

export function normalizeAmazonHeader(header: string): string {
  return String(header)
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function looksLikeAmazonSettlementHeaders(headers: string[]): boolean {
  const normalized = new Set(headers.map(normalizeAmazonHeader));
  const has = (...names: string[]) => names.some((name) => normalized.has(normalizeAmazonHeader(name)));
  return (
    has("settlement-id") &&
    has("amount-type") &&
    has("amount-description") &&
    has("amount") &&
    (has("posted-date") || has("posted-date-time"))
  );
}

export function amazonValue(raw: Record<string, unknown>, key: string): string {
  const target = normalizeAmazonHeader(key);
  const entry = Object.entries(raw).find(([rawKey, value]) =>
    normalizeAmazonHeader(rawKey) === target && value !== undefined && value !== null && String(value).trim() !== ""
  );
  return entry ? String(entry[1]).trim() : "";
}

export function parseAmazonAmount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const original = String(value ?? "").trim();
  if (!original) return 0;
  const parenthesized = /^\(.*\)$/.test(original);
  const numeric = original.replace(/\u2212/g, "-").replace(/[^0-9,.-]/g, "");
  const lastComma = numeric.lastIndexOf(",");
  const lastDot = numeric.lastIndexOf(".");
  const commaIsDecimal = lastComma > lastDot && numeric.length - lastComma - 1 <= 2;
  const normalized = commaIsDecimal
    ? numeric.replace(/\./g, "").replace(",", ".")
    : numeric.replace(/,/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return parenthesized ? -Math.abs(parsed) : parsed;
}

export function isAmazonSummaryRow(raw: Record<string, unknown>): boolean {
  return Boolean(
    amazonValue(raw, "settlement-id") &&
    !amazonValue(raw, "amount-type") &&
    !amazonValue(raw, "amount-description") &&
    !amazonValue(raw, "amount") &&
    amazonValue(raw, "total-amount")
  );
}

export function amazonOrderRef(raw: Record<string, unknown>): string {
  // merchant-order-id is the seller's Shopify-facing key when present. The
  // Amazon order-id remains in metadata for auditability and investigation.
  return amazonValue(raw, "merchant-order-id") || amazonValue(raw, "order-id");
}

export function amazonLineDate(raw: Record<string, unknown>, fallback?: string): string {
  return parseDateToIso(
    amazonValue(raw, "posted-date-time") ||
      amazonValue(raw, "posted-date") ||
      amazonValue(raw, "settlement-end-date") ||
      amazonValue(raw, "settlement-start-date"),
    fallback
  );
}

function contains(value: string, pattern: RegExp): boolean {
  return pattern.test(value.toLowerCase());
}

/**
 * Deterministic first pass. It uses both amount-type and amount-description:
 * the same description (notably Shipping and Tax) legitimately appears under
 * multiple amount types in Flat File V2.
 */
export function classifyAmazonLine(raw: Record<string, unknown>, amount: number): AmazonLineClassification {
  const amountType = amazonValue(raw, "amount-type");
  const description = amazonValue(raw, "amount-description");
  const transactionType = amazonValue(raw, "transaction-type");
  const combined = `${amountType} ${description} ${transactionType}`;
  const lowerType = amountType.toLowerCase();
  const lowerDescription = description.toLowerCase();
  const isStatutoryWithholding = contains(combined, /\b(item)?tcs\b|\b(item)?tds\b|tax collected at source|tax deducted at source/);
  const isRefund = contains(transactionType, /refund|return/) || contains(description, /refund|return|restocking|chargeback/);
  const isDeduction = amount < 0;

  if (isStatutoryWithholding) {
    return {
      category: "statutory_tax_withholding",
      label: "Statutory tax withholding",
      isDeduction,
      isStatutoryWithholding: true,
      requiresAgent: false,
      reason: "TCS/TDS is an expected statutory withholding and is excluded from anomaly detection.",
    };
  }
  if (isRefund && contains(description, /return|restocking|shipping chargeback|refund/)) {
    return {
      category: "return_processing_charge",
      label: "Return processing charge",
      isDeduction,
      isStatutoryWithholding: false,
      requiresAgent: contains(transactionType, /refund|return/),
      reason: "The transaction or amount description indicates a refund, return, restocking, or chargeback.",
    };
  }
  if (contains(description, /principal/) && !isRefund) {
    return {
      category: "sale_proceeds",
      label: "Sale proceeds",
      isDeduction: false,
      isStatutoryWithholding: false,
      requiresAgent: false,
      reason: "ItemPrice / Principal is the order proceeds line.",
    };
  }
  if (contains(description, /commission|referral/)) {
    return { category: "referral_fee", label: "Referral fee", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "Commission/referral vocabulary maps to marketplace selling fees." };
  }
  if (contains(description, /closing/)) {
    return { category: "closing_fee", label: "Closing fee", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "Closing-fee vocabulary is a known Amazon selling charge." };
  }
  if (contains(combined, /weight|transportation|shippinghb/)) {
    return { category: "weight_handling_fee", label: "Weight or handling fee", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "Weight/transport/handling vocabulary maps to fulfillment handling charges." };
  }
  if (contains(combined, /fulfillment|fba/)) {
    return { category: "fulfillment_fee", label: "Fulfillment fee", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "FBA/fulfillment vocabulary maps to fulfillment charges." };
  }
  if (contains(combined, /shipping|freight|shipment/)) {
    return { category: "shipping_fee", label: "Shipping fee", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "Shipping/shipment vocabulary maps to logistics charges or credits." };
  }
  if (contains(combined, /storage/)) {
    return { category: "storage_fee", label: "Storage fee", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "Storage vocabulary maps to inventory storage charges." };
  }
  if (lowerType.includes("promotion") || contains(combined, /promotion|rebate|deal/)) {
    return { category: "promotional_rebate", label: "Promotional rebate", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "Promotion/rebate vocabulary maps to promotional credits or clawbacks." };
  }
  if (contains(combined, /reserve|balance/)) {
    return { category: "reserve_or_balance", label: "Reserve or balance movement", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "Reserve/balance movements are settlement-level accounting entries." };
  }
  if (isRefund) {
    return { category: "return_processing_charge", label: "Return or refund movement", isDeduction, isStatutoryWithholding: false, requiresAgent: true, reason: "Refund/return signal found, but the exact Amazon code needs contextual review." };
  }
  if (contains(combined, /tax|vat|gst/)) {
    return { category: "tax_or_marketplace_fee", label: "Marketplace tax or fee", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "Tax/VAT/GST vocabulary is retained as a tax or marketplace charge." };
  }
  if (!description && !amountType) {
    return { category: "adjustment", label: "Settlement adjustment", isDeduction, isStatutoryWithholding: false, requiresAgent: false, reason: "The row has no line-item code and is treated as a settlement adjustment." };
  }
  return { category: "unrecognized_deduction", label: "Unrecognized deduction", isDeduction, isStatutoryWithholding: false, requiresAgent: true, reason: "Amazon's amount-description vocabulary is open-ended; this code needs contextual agent review." };
}

export function isAmazonReturnClawback(raw: Record<string, unknown>): boolean {
  const transactionType = amazonValue(raw, "transaction-type");
  const description = amazonValue(raw, "amount-description");
  return contains(`${transactionType} ${description}`, /refund|return|restocking|chargeback/);
}
