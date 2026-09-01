import type { ExtractedRecord, NormalizedEvent } from "../../shared/types";
import { parseDateToIso } from "../../shared/types";
import { amazonValue } from "../amazon";
import type { NormalizationContext, SourceNormalizerAdapter, ValidationResult } from "../types";

/**
 * Reads a value from a raw CSV row, trying multiple column name variants.
 * Amazon exports use both snake_case (order_id) and hyphenated (order-id)
 * column names depending on the report type.
 */
function orderValue(raw: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const directVal = String(raw[key] ?? "").trim();
    if (directVal) return directVal;
    // Case-insensitive fallback
    const lowerKey = key.toLowerCase();
    const entry = Object.entries(raw).find(([k]) => k.toLowerCase().trim() === lowerKey);
    if (entry && String(entry[1]).trim()) return String(entry[1]).trim();
  }
  return "";
}

function parseOrderAmount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const str = String(value ?? "").replace(/[₹,\s]/g, "");
  const parsed = parseFloat(str);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Normalises a standalone Amazon Orders CSV into one SALE event per order and
 * upserts matching rows into core.orders so that the AmazonAdapter (settlement)
 * can later resolve order_id references via the same lookup it already performs.
 *
 * Column variants handled (underscored or hyphenated):
 *   order_id / order-id / amazon-order-id
 *   order_number / merchant-order-id
 *   order_date / order-date
 *   total_amount / total-amount / product-sales / item-total / order-total
 *   currency
 *   status / order-status / order_status
 *   customer_name / buyer-name
 *   customer_email / buyer-email
 */
export class AmazonOrdersAdapter implements SourceNormalizerAdapter {
  readonly detectedSource = "amazon_orders";
  readonly requiredFields = ["order_id / order-id", "order_date / order-date"];
  /**
   * Priority 2: runs after Shopify (1) but before Amazon Settlement (3) so
   * orders are seeded in core.orders before the settlement adapter needs them.
   */
  readonly priority = 2;

  validate(records: ExtractedRecord[]): ValidationResult {
    const recordIssues = records.flatMap((record) => {
      const raw = record.raw_json;
      const orderId = orderValue(raw, "order_id", "order-id", "amazon-order-id");
      if (!orderId) {
        return [{ recordId: record.id, missingFields: ["order_id / order-id"] }];
      }
      return [];
    });
    return {
      valid: recordIssues.length === 0,
      recordIssues: recordIssues.length ? recordIssues : undefined,
    };
  }

  async normalize(records: ExtractedRecord[], context: NormalizationContext): Promise<NormalizedEvent[]> {
    const { missionId, merchantId, supabase } = context;

    // Group records by order ID (CSV may have multiple line items per order)
    const groups = new Map<string, ExtractedRecord[]>();
    for (const record of records) {
      const raw = record.raw_json;
      const orderId = orderValue(raw, "order_id", "order-id", "amazon-order-id");
      if (!orderId) continue;
      const group = groups.get(orderId) || [];
      group.push(record);
      groups.set(orderId, group);
    }

    const events: NormalizedEvent[] = [];

    for (const [orderId, orderRecords] of groups.entries()) {
      const representative = orderRecords[0];
      const raw = representative.raw_json;

      const orderNumber = orderValue(raw, "order_number", "merchant-order-id", "order_id", "order-id");
      const orderDate = parseDateToIso(orderValue(raw, "order_date", "order-date"));
      const currency = orderValue(raw, "currency") || "INR";
      const status = orderValue(raw, "status", "order-status", "order_status").toLowerCase();
      const customerEmail = orderValue(raw, "customer_email", "buyer-email");
      const customerName = orderValue(raw, "customer_name", "buyer-name");

      // Skip fully cancelled orders — no revenue event
      if (status === "cancelled" || status === "canceled") continue;

      // Sum total_amount across all line items for this order
      const totalAmount = orderRecords.reduce((sum, rec) => {
        const rawAmount = orderValue(
          rec.raw_json,
          "total_amount",
          "total-amount",
          "product-sales",
          "product_sales",
          "item-total",
          "item_total",
          "order-total",
          "order_total"
        );
        return sum + parseOrderAmount(rawAmount);
      }, 0);

      if (totalAmount <= 0) continue;

      // 1. Upsert customer (if email present)
      let customerId: string | null = null;
      if (customerEmail) {
        const { data: customerData } = await supabase
          .schema("core")
          .from("customers")
          .upsert(
            {
              merchant_id: merchantId,
              external_ref: customerEmail,
              name: customerName || null,
              email: customerEmail,
            },
            { onConflict: "merchant_id,external_ref" }
          )
          .select("id")
          .single();
        if (customerData) customerId = customerData.id;
      }

      // 2. Upsert order into core.orders so the settlement adapter's lookup
      //    can find it by external_ref / order_number.
      let dbOrderId: string | null = null;
      const { data: orderData } = await supabase
        .schema("core")
        .from("orders")
        .upsert(
          {
            merchant_id: merchantId,
            customer_id: customerId,
            external_ref: orderId,
            order_number: orderNumber || orderId,
            total_amount: totalAmount,
            currency,
            status,
            order_date: orderDate,
          },
          { onConflict: "merchant_id,external_ref" }
        )
        .select("id")
        .single();
      if (orderData) dbOrderId = orderData.id;

      // 3. Emit a SALE event
      events.push({
        mission_id: missionId,
        merchant_id: merchantId,
        extracted_record_id: representative.id,
        event_type: "SALE",
        source_system: "amazon",
        external_ref: orderId,
        amount: Math.round(totalAmount * 100) / 100,
        currency,
        event_date: orderDate,
        counterparty: "Amazon Marketplace",
        order_id: dbOrderId,
        customer_id: customerId,
        order_ids: [orderId],
        metadata: {
          raw_source_row: raw,
          order_id: orderId,
          order_number: orderNumber || orderId,
          order_date: orderDate,
          order_status: status,
          customer_email: customerEmail || null,
          customer_name: customerName || null,
          source_file_type: "amazon_orders_csv",
          line_item_count: orderRecords.length,
        },
      });
    }

    return events;
  }
}
