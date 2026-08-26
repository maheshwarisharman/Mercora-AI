import type { ExtractedRecord, NormalizedEvent } from "../../shared/types";
import type { NormalizationContext, SourceNormalizerAdapter, ValidationResult } from "../types";
import { mapShopifyOrder, normalizeShopifyOrderRow } from "../shopify";

export class ShopifyAdapter implements SourceNormalizerAdapter {
  readonly detectedSource = "shopify_orders";
  // Shopify can provide either native labels (`Name`, `Total`, `Created at`)
  // or canonical keys from an API/import pipeline, so field names are resolved
  // semantically by normalizeShopifyOrderRow instead of being required here.
  readonly requiredFields = [];
  readonly priority = 1;

  validate(records: ExtractedRecord[]): ValidationResult {
    const missing: string[] = [];
    const recordIssues: Array<{ recordId: string; missingFields: string[] }> = [];

    for (const rec of records) {
      const normalized = normalizeShopifyOrderRow(rec.raw_json);
      const missingForRec = normalized.orderId ? [] : ["order identifier"];
      if (missingForRec.length > 0) {
        recordIssues.push({ recordId: rec.id, missingFields: missingForRec });
      }
    }

    return {
      valid: recordIssues.length === 0,
      missingFields: missing,
      recordIssues: recordIssues.length > 0 ? recordIssues : undefined,
    };
  }

  async normalize(
    records: ExtractedRecord[],
    context: NormalizationContext
  ): Promise<NormalizedEvent[]> {
    const { missionId, merchantId, supabase } = context;
    const events: NormalizedEvent[] = [];

    // Shopify's CSV export is line-item based. Order-level values are usually
    // present only on the first row, so group rows by the resolved order
    // identity and normalize one order summary per group.
    const groups = new Map<string, Array<{ record: ExtractedRecord; normalized: ReturnType<typeof normalizeShopifyOrderRow> }>>();
    for (const record of records) {
      const normalized = normalizeShopifyOrderRow(record.raw_json);
      const groupKey = normalized.orderId ? `order:${normalized.orderId}` : `record:${record.id}`;
      const group = groups.get(groupKey) || [];
      group.push({ record, normalized });
      groups.set(groupKey, group);
    }

    for (const group of groups.values()) {
      const representative =
        group.find(({ normalized }) => normalized.totalAmount !== null) || group[0];
      const rec = representative.record;
      const raw = rec.raw_json;
      const normalized = representative.normalized;
      let customerId: string | null = null;
      let orderId: string | null = null;

      const email = normalized.customerEmail;
      const customerName = normalized.customerName;
      const orderRef = normalized.orderId;
      const orderNumber = normalized.orderNumber;
      const totalAmount = normalized.totalAmount ?? 0;
      const orderDate = normalized.orderDate;
      const status = normalized.status;
      const currency = normalized.currency;

      // 1. Upsert Customer
      if (email) {
        const { data: customerData, error: custError } = await supabase
          .schema("core")
          .from("customers")
          .upsert(
            {
              merchant_id: merchantId,
              external_ref: email,
              name: customerName,
              email: email,
            },
            { onConflict: "merchant_id,external_ref" }
          )
          .select("id")
          .single();

        if (!custError && customerData) {
          customerId = customerData.id;
        }
      }

      // 2. Upsert Order
      if (orderRef) {
        const { data: orderData, error: ordError } = await supabase
          .schema("core")
          .from("orders")
          .upsert(
            {
              merchant_id: merchantId,
              customer_id: customerId,
              external_ref: orderRef,
              order_number: orderNumber,
              total_amount: totalAmount,
              currency: currency,
              status: status,
              order_date: orderDate,
            },
            { onConflict: "merchant_id,external_ref" }
          )
          .select("id")
          .single();

        if (!ordError && orderData) {
          orderId = orderData.id;
        }
      }

      // 3. Map SALE and conditional REFUND events
      const mapped = mapShopifyOrder(raw, merchantId, missionId, rec.id, {
        order_id: orderId,
        customer_id: customerId,
        source_record_ids: group.map(({ record }) => record.id),
      });

      mapped.forEach((evt) => events.push(evt));
    }

    return events;
  }
}
