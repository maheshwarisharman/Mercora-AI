import type { ExtractedRecord, NormalizedEvent } from "../../shared/types";
import { parseDateToIso } from "../../shared/types";
import type { NormalizationContext, SourceNormalizerAdapter, ValidationResult } from "../types";
import { mapShopifyOrder } from "../shopify";

export class ShopifyAdapter implements SourceNormalizerAdapter {
  readonly detectedSource = "shopify_orders";
  readonly requiredFields = ["order_id", "total_amount"];
  readonly priority = 1;

  validate(records: ExtractedRecord[]): ValidationResult {
    const missing: string[] = [];
    const recordIssues: Array<{ recordId: string; missingFields: string[] }> = [];

    for (const rec of records) {
      const missingForRec = this.requiredFields.filter(
        (f) => rec.raw_json[f] === undefined || rec.raw_json[f] === null || rec.raw_json[f] === ""
      );
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

    for (const rec of records) {
      const raw = rec.raw_json;
      let customerId: string | null = null;
      let orderId: string | null = null;

      const email = raw.customer_email ? String(raw.customer_email).trim() : null;
      const customerName = raw.customer_name ? String(raw.customer_name).trim() : null;
      const orderRef = String(raw.order_id || "").trim();
      const orderNumber = raw.order_number ? String(raw.order_number).trim() : null;
      const totalAmount = parseFloat(raw.total_amount || "0");
      const orderDate = parseDateToIso(raw.order_date || raw.date || raw.created_at);
      const status = raw.status ? String(raw.status).trim() : null;
      const currency = raw.currency ? String(raw.currency).trim().toUpperCase() : "INR";

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
              total_amount: isNaN(totalAmount) ? 0 : totalAmount,
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
      });

      mapped.forEach((evt) => events.push(evt));
    }

    return events;
  }
}
