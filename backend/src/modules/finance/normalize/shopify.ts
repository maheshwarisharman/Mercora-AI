import { parseDateToIso, type NormalizedEvent } from "../shared/types";

type RawRow = Record<string, any>;

export interface NormalizedShopifyRow {
  orderId: string;
  orderNumber: string | null;
  customerEmail: string | null;
  customerName: string | null;
  totalAmount: number | null;
  refundAmount: number | null;
  orderDate: string;
  status: string | null;
  currency: string;
}

interface FieldEntry {
  key: string;
  normalizedKey: string;
  value: any;
}

/**
 * Normalizes a header for semantic matching. Shopify exports use labels such
 * as `Created at`, while API/import pipelines commonly use `created_at`.
 */
function normalizeHeader(header: string): string {
  return String(header)
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function entriesFor(raw: RawRow): FieldEntry[] {
  return Object.entries(raw).map(([key, value]) => ({
    key,
    normalizedKey: normalizeHeader(key),
    value,
  }));
}

function hasValue(value: any): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function firstField(
  entries: FieldEntry[],
  scorer: (entry: FieldEntry) => number,
  requireValue = true
): FieldEntry | undefined {
  return entries
    .filter((entry) => !requireValue || hasValue(entry.value))
    .map((entry) => ({ entry, score: scorer(entry) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key))[0]?.entry;
}

function textValue(field?: FieldEntry): string | null {
  if (!field || !hasValue(field.value)) return null;
  return String(field.value).trim();
}

function parseAmount(value: any): number | null {
  if (!hasValue(value)) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const original = String(value).trim();
  const isParenthesized = /^\(.*\)$/.test(original);
  const numericPart = original
    .replace(/\u2212/g, "-")
    .replace(/[^0-9,.-]/g, "");
  const lastComma = numericPart.lastIndexOf(",");
  const lastDot = numericPart.lastIndexOf(".");
  const commaLooksDecimal =
    lastComma >= 0 &&
    lastComma > lastDot &&
    numericPart.length - lastComma - 1 > 0 &&
    numericPart.length - lastComma - 1 <= 2;
  const normalized = commaLooksDecimal
    ? numericPart.replace(/\./g, "").replace(",", ".")
    : numericPart.replace(/,/g, "");
  if (!normalized || normalized === "." || normalized === "-" || normalized === "+") return null;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return isParenthesized ? -Math.abs(parsed) : parsed;
}

function scoreOrderIdentifier(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (key === "orderid") return 130;
  if (key === "orderref" || key === "orderreference") return 125;
  if (key === "ordernumber" || key === "orderno") return 120;
  if (key.includes("order") && /(id|ref|number|no)$/.test(key)) return 110;
  // Shopify's native order export calls the order number simply `Name`.
  if (key === "name" && /^#?[a-z0-9-]+$/i.test(String(entry.value).trim())) return 100;
  if (key === "id") return 20;
  return 0;
}

function scoreOrderNumber(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (key === "ordernumber" || key === "orderno") return 130;
  if (key === "ordername") return 125;
  if (key === "name" && /^#?[a-z0-9-]+$/i.test(String(entry.value).trim())) return 120;
  if (key.includes("order") && /(number|no|name)$/.test(key)) return 110;
  return 0;
}

function scoreTotal(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (
    /(subtotal|shipping|tax|discount|refund|outstanding|lineitem|compare|dut|fee|price)/.test(key)
  ) {
    return 0;
  }
  if (key === "totalamount" || key === "ordertotal") return 140;
  if (key === "total") return 130;
  if (key.includes("total") && !key.includes("quantity")) return 120;
  if (key === "amount" || key === "orderamount") return 100;
  if (key.includes("amount") && key.includes("order")) return 90;
  return 0;
}

function scoreRefund(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (!key.includes("refund")) return 0;
  if (key === "refundedamount" || key === "refundamount") return 130;
  if (key.includes("amount")) return 120;
  return 100;
}

function scoreDate(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (/(fulfilled|paid|cancel|refund|due|ship)/.test(key)) return 0;
  if (key === "orderdate") return 140;
  if (key === "createdat" || key === "created") return 130;
  if (key === "date") return 120;
  if (key.includes("order") && key.includes("date")) return 115;
  if (key.includes("created")) return 110;
  return 0;
}

function scoreStatus(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (key === "financialstatus") return 140;
  if (key === "orderstatus" || key === "paymentstatus") return 130;
  if (key === "status") return 120;
  if (key.includes("status")) return 100;
  return 0;
}

function scoreEmail(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (key === "customeremail" || key === "buyeremail") return 130;
  if (key === "email" || key === "contactemail") return 120;
  if (key.includes("email")) return 100;
  return 0;
}

function scoreCustomerName(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (key === "customername" || key === "buyername") return 140;
  if (key === "billingname") return 130;
  if (key === "shippingname") return 120;
  if (key.includes("customer") && key.includes("name")) return 110;
  if (key.includes("buyer") && key.includes("name")) return 105;
  return 0;
}

function scoreCurrency(entry: FieldEntry): number {
  const key = entry.normalizedKey;
  if (key === "currency" || key === "currencycode") return 130;
  if (key.includes("currency")) return 100;
  return 0;
}

/**
 * Detects both the app's canonical keys and Shopify's native export headers.
 * This deliberately uses semantic header characteristics rather than a
 * fixed column order or a single exact merchant template.
 */
export function looksLikeShopifyOrderHeaders(headers: string[]): boolean {
  const keys = headers.map(normalizeHeader);
  const has = (...patterns: string[]) => keys.some((key) => patterns.some((pattern) => key.includes(pattern)));

  const hasOrderIdentity =
    has("orderid", "ordernumber", "orderref", "ordername") || keys.includes("name");
  const hasOrderTotal = has("totalamount", "ordertotal") || keys.includes("total");
  const hasShopifySignals =
    has("financialstatus", "fulfillmentstatus", "lineitem", "acceptsmarketing", "shippingmethod") ||
    (has("currency") && has("created"));

  return hasOrderIdentity && hasOrderTotal && hasShopifySignals;
}

/**
 * Resolves a Shopify row into canonical values without mutating the source
 * record. It supports native Shopify labels as well as canonical/internal
 * keys produced by other ingestion paths.
 */
export function normalizeShopifyOrderRow(raw: RawRow): NormalizedShopifyRow {
  const entries = entriesFor(raw);
  const orderIdentifier = firstField(entries, scoreOrderIdentifier);
  const orderNumber = firstField(entries, scoreOrderNumber);
  const total = firstField(entries, scoreTotal);
  const refund = firstField(entries, scoreRefund);
  const date = firstField(entries, scoreDate);
  const status = firstField(entries, scoreStatus);
  const email = firstField(entries, scoreEmail);
  const customerName = firstField(entries, scoreCustomerName);
  const currency = firstField(entries, scoreCurrency);

  const resolvedOrderId = textValue(orderIdentifier) || textValue(orderNumber) || "";

  return {
    orderId: resolvedOrderId,
    orderNumber: textValue(orderNumber) || (resolvedOrderId || null),
    customerEmail: textValue(email),
    customerName: textValue(customerName),
    totalAmount: parseAmount(total?.value),
    refundAmount: parseAmount(refund?.value),
    orderDate: parseDateToIso(date?.value),
    status: textValue(status),
    currency: (textValue(currency) || "INR").toUpperCase(),
  };
}

/**
 * Pure mapping function for a Shopify order row.
 * Produces one SALE event and an optional REFUND event.
 */
export function mapShopifyOrder(
  raw: RawRow,
  merchantId: string,
  missionId: string,
  extractedRecordId: string,
  links?: {
    order_id?: string | null;
    customer_id?: string | null;
    source_record_ids?: string[];
  }
): NormalizedEvent[] {
  const normalized = normalizeShopifyOrderRow(raw);
  const events: NormalizedEvent[] = [];
  const orderId = normalized.orderId;
  const status = normalized.status || "";
  const sourceRecordIds = links?.source_record_ids || [extractedRecordId];

  events.push({
    mission_id: missionId,
    merchant_id: merchantId,
    extracted_record_id: extractedRecordId,
    event_type: "SALE",
    source_system: "shopify",
    external_ref: orderId || null,
    amount: normalized.totalAmount ?? 0,
    currency: normalized.currency,
    event_date: normalized.orderDate,
    counterparty: normalized.customerName,
    order_id: links?.order_id || null,
    customer_id: links?.customer_id || null,
    metadata: {
      raw_source_row: raw,
      source_record_ids: sourceRecordIds,
      order_number: normalized.orderNumber,
      customer_email: normalized.customerEmail,
      status: normalized.status,
    },
  });

  if (normalized.refundAmount !== null && normalized.refundAmount > 0) {
    events.push({
      mission_id: missionId,
      merchant_id: merchantId,
      extracted_record_id: extractedRecordId,
      event_type: "REFUND",
      source_system: "shopify",
      external_ref: `${orderId}-refund`,
      amount: Math.abs(normalized.refundAmount),
      currency: normalized.currency,
      event_date: normalized.orderDate,
      counterparty: normalized.customerName,
      order_id: links?.order_id || null,
      customer_id: links?.customer_id || null,
      metadata: {
        raw_source_row: raw,
        source_record_ids: sourceRecordIds,
        original_order_id: orderId,
        refund_status: status || null,
      },
    });
  }

  return events;
}
