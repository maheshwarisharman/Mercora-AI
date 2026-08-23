import { parseDateToIso, type NormalizedEvent } from "../shared/types";

/**
 * Pure mapping function for Razorpay Transactions CSV row.
 * Produces 3 events from a single row: PAYMENT, FEE, and SETTLEMENT.
 */
export function mapRazorpayTransaction(
  raw: Record<string, any>,
  merchantId: string,
  missionId: string,
  extractedRecordId: string,
  links?: { order_id?: string | null; payment_id?: string | null }
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  const paymentId = String(raw.payment_id || "").trim();
  const paymentDate = parseDateToIso(raw.payment_date || raw.date || raw.created_at);
  const settlementId = String(raw.settlement_id || "").trim();
  const settlementDate = parseDateToIso(raw.settlement_date, paymentDate);
  const orderRef = String(raw.order_ref || "").trim();

  const grossAmount = parseFloat(raw.gross_amount || "0");
  const feeAmount = parseFloat(raw.fee_amount || "0");
  const taxOnFee = parseFloat(raw.tax_on_fee || "0");
  const netAmount = parseFloat(raw.net_amount || "0");

  const totalFee = (isNaN(feeAmount) ? 0 : feeAmount) + (isNaN(taxOnFee) ? 0 : taxOnFee);

  // 1. PAYMENT event
  events.push({
    mission_id: missionId,
    merchant_id: merchantId,
    extracted_record_id: extractedRecordId,
    event_type: "PAYMENT",
    source_system: "razorpay",
    external_ref: paymentId || null,
    amount: isNaN(grossAmount) ? 0 : grossAmount,
    currency: "INR",
    event_date: paymentDate,
    counterparty: "Razorpay",
    order_id: links?.order_id || null,
    payment_id: links?.payment_id || null,
    metadata: {
      raw_source_row: raw,
      order_ref: orderRef,
      status: raw.status,
      settlement_id: settlementId,
    },
  });

  // 2. FEE event
  events.push({
    mission_id: missionId,
    merchant_id: merchantId,
    extracted_record_id: extractedRecordId,
    event_type: "FEE",
    source_system: "razorpay",
    external_ref: `${paymentId}-fee`,
    amount: Math.abs(totalFee),
    currency: "INR",
    event_date: paymentDate,
    counterparty: "Razorpay",
    order_id: links?.order_id || null,
    payment_id: links?.payment_id || null,
    metadata: {
      raw_source_row: raw,
      base_fee: feeAmount,
      tax_on_fee: taxOnFee,
      parent_payment_id: paymentId,
    },
  });

  // 3. SETTLEMENT event
  events.push({
    mission_id: missionId,
    merchant_id: merchantId,
    extracted_record_id: extractedRecordId,
    event_type: "SETTLEMENT",
    source_system: "razorpay",
    external_ref: settlementId || `${paymentId}-settlement`,
    amount: isNaN(netAmount) ? 0 : netAmount,
    currency: "INR",
    event_date: settlementDate,
    counterparty: "Razorpay",
    metadata: {
      raw_source_row: raw,
      payment_id: paymentId,
      settlement_date: settlementDate,
    },
  });

  return events;
}
