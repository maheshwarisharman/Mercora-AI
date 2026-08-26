import type { ExtractedRecord, NormalizedEvent } from "../../shared/types";
import { parseDateToIso } from "../../shared/types";
import type { NormalizationContext, SourceNormalizerAdapter, ValidationResult } from "../types";
import { mapRazorpayTransaction } from "../razorpay";

export class RazorpayAdapter implements SourceNormalizerAdapter {
  readonly detectedSource = "razorpay_settlement";
  readonly requiredFields = ["payment_id"];
  readonly priority = 2;

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
      const paymentId = String(raw.payment_id || "").trim();
      const orderRef = String(raw.order_ref || "").trim();
      const grossAmount = parseFloat(raw.gross_amount || "0");
      const paymentDate = parseDateToIso(raw.payment_date || raw.date || raw.created_at);
      const status = raw.status ? String(raw.status).trim() : null;

      let resolvedOrderId: string | null = null;
      let paymentUuid: string | null = null;

      // 1. Resolve core.orders linkage via order_ref
      if (orderRef) {
        const { data: matchedOrder } = await supabase
          .schema("core")
          .from("orders")
          .select("id")
          .eq("merchant_id", merchantId)
          .or(`external_ref.eq."${orderRef}",order_number.eq."${orderRef}"`)
          .maybeSingle();

        if (matchedOrder) {
          resolvedOrderId = matchedOrder.id;
        }
      }

      // 2. Upsert core.payments
      if (paymentId) {
        const { data: paymentData, error: payError } = await supabase
          .schema("core")
          .from("payments")
          .upsert(
            {
              merchant_id: merchantId,
              order_id: resolvedOrderId,
              external_ref: paymentId,
              amount: isNaN(grossAmount) ? 0 : grossAmount,
              currency: "INR",
              status: status,
              payment_date: paymentDate,
            },
            { onConflict: "merchant_id,external_ref" }
          )
          .select("id")
          .single();

        if (!payError && paymentData) {
          paymentUuid = paymentData.id;
        }
      }

      // 3. Map PAYMENT, FEE, SETTLEMENT events
      const mapped = mapRazorpayTransaction(raw, merchantId, missionId, rec.id, {
        order_id: resolvedOrderId,
        payment_id: paymentUuid,
      });

      mapped.forEach((evt) => events.push(evt));
    }

    return events;
  }
}
