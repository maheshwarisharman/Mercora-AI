import type { NormalizedEvent } from "../shared/types";

/**
 * Pure mapping function for Shopify Orders CSV row.
 * Produces a SALE event and an optional REFUND event.
 */
export function mapShopifyOrder(
  raw: Record<string, any>,
  merchantId: string,
  missionId: string,
  extractedRecordId: string,
  links?: { order_id?: string | null; customer_id?: string | null }
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  const totalAmount = parseFloat(raw.total_amount || "0");
  const orderId = String(raw.order_id || "").trim();
  const customerName = raw.customer_name ? String(raw.customer_name).trim() : null;
  const orderDate = String(raw.order_date || "").trim();
  const status = String(raw.status || "").toLowerCase().trim();
  const currency = String(raw.currency || "INR").trim().toUpperCase();

  // 1. SALE event
  events.push({
    mission_id: missionId,
    merchant_id: merchantId,
    extracted_record_id: extractedRecordId,
    event_type: "SALE",
    source_system: "shopify",
    external_ref: orderId || null,
    amount: isNaN(totalAmount) ? 0 : totalAmount,
    currency,
    event_date: orderDate,
    counterparty: customerName,
    order_id: links?.order_id || null,
    customer_id: links?.customer_id || null,
    metadata: {
      raw_source_row: raw,
      order_number: raw.order_number,
      customer_email: raw.customer_email,
      status: raw.status,
    },
  });

  // 2. REFUND event if applicable
  if (status.includes("refund")) {
    const refundAmount = parseFloat(raw.refund_amount || "0");
    if (!isNaN(refundAmount) && refundAmount > 0) {
      events.push({
        mission_id: missionId,
        merchant_id: merchantId,
        extracted_record_id: extractedRecordId,
        event_type: "REFUND",
        source_system: "shopify",
        external_ref: `${orderId}-refund`,
        amount: Math.abs(refundAmount),
        currency,
        event_date: orderDate,
        counterparty: customerName,
        order_id: links?.order_id || null,
        customer_id: links?.customer_id || null,
        metadata: {
          raw_source_row: raw,
          original_order_id: orderId,
          refund_status: raw.status,
        },
      });
    }
  }

  return events;
}
