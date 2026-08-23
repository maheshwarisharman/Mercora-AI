import { getServiceSupabase } from "../../../shared/db/supabase";
import { writeAuditLog } from "../shared/audit";
import { mapShopifyOrder } from "./shopify";
import { mapRazorpayTransaction } from "./razorpay";
import { mapBankTransaction } from "./bank";
import { parseDateToIso, type ExtractedRecord, type NormalizedEvent, type SourceDocument } from "../shared/types";

export interface NormalizationSummary {
  events_created: number;
  by_type: Record<string, number>;
  mission_status: string;
  processed_records_count: number;
}

/**
 * Orchestrates mission normalization across all unnormalized extracted records.
 * Follows strict source order: shopify -> razorpay -> bank.
 * Fully idempotent: re-running skips already-normalized records without duplication.
 */
export async function runMissionNormalization(params: {
  missionId: string;
  merchantId: string;
  actorUserId?: string | null;
}): Promise<NormalizationSummary> {
  const { missionId, merchantId, actorUserId } = params;
  const supabase = getServiceSupabase();

  // 1. Fetch all source documents for this mission to map source_document_id -> detected_source
  const { data: documents, error: docsError } = await supabase
    .schema("finance")
    .from("source_documents")
    .select("*")
    .eq("mission_id", missionId)
    .eq("merchant_id", merchantId);

  if (docsError || !documents) {
    throw new Error(`Failed to load mission source documents: ${docsError?.message}`);
  }

  const docMap = new Map<string, SourceDocument>();
  documents.forEach((doc) => docMap.set(doc.id, doc as SourceDocument));

  // 2. Fetch all extracted records for this mission
  const { data: extractedRecords, error: extError } = await supabase
    .schema("finance")
    .from("extracted_records")
    .select("*")
    .eq("mission_id", missionId)
    .eq("merchant_id", merchantId);

  if (extError || !extractedRecords) {
    throw new Error(`Failed to fetch extracted records: ${extError?.message}`);
  }

  // 3. Find extracted_record_ids that already have normalized events (Idempotency Check)
  const { data: existingEvents, error: existingError } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select("extracted_record_id")
    .eq("mission_id", missionId)
    .eq("merchant_id", merchantId);

  if (existingError) {
    throw new Error(`Failed to check existing normalized events: ${existingError.message}`);
  }

  const existingExtractedIds = new Set(
    (existingEvents || []).map((e: { extracted_record_id: string }) => e.extracted_record_id)
  );

  // Filter only unnormalized records
  const unnormalizedRecords = (extractedRecords as ExtractedRecord[]).filter(
    (r) => !existingExtractedIds.has(r.id)
  );

  // If nothing to normalize, return early summary
  if (unnormalizedRecords.length === 0) {
    return {
      events_created: 0,
      by_type: {},
      mission_status: "reconciling",
      processed_records_count: 0,
    };
  }

  // 4. Partition and sort unnormalized records into fixed sequence:
  // shopify_orders -> razorpay_settlement -> bank_statement
  const shopifyRecords: ExtractedRecord[] = [];
  const razorpayRecords: ExtractedRecord[] = [];
  const bankRecords: ExtractedRecord[] = [];

  for (const record of unnormalizedRecords) {
    const doc = docMap.get(record.source_document_id);
    const source = doc?.detected_source;

    if (source === "shopify_orders") {
      shopifyRecords.push(record);
    } else if (source === "razorpay_settlement") {
      razorpayRecords.push(record);
    } else if (source === "bank_statement") {
      bankRecords.push(record);
    }
  }

  const allEventsToInsert: NormalizedEvent[] = [];
  const byTypeCount: Record<string, number> = {};

  const recordEventCount = (type: string) => {
    byTypeCount[type] = (byTypeCount[type] || 0) + 1;
  };

  // --------------------------------------------------------------------------
  // STAGE A: Normalize Shopify Orders (Populates core.customers & core.orders)
  // --------------------------------------------------------------------------
  for (const rec of shopifyRecords) {
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

    // A1. Upsert Customer
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

    // A2. Upsert Order
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

    // A3. Generate SALE and conditional REFUND events
    const mapped = mapShopifyOrder(raw, merchantId, missionId, rec.id, {
      order_id: orderId,
      customer_id: customerId,
    });

    mapped.forEach((evt) => {
      allEventsToInsert.push(evt);
      recordEventCount(evt.event_type);
    });
  }

  // --------------------------------------------------------------------------
  // STAGE B: Normalize Razorpay Transactions (Links to core.orders & core.payments)
  // --------------------------------------------------------------------------
  for (const rec of razorpayRecords) {
    const raw = rec.raw_json;
    const paymentId = String(raw.payment_id || "").trim();
    const orderRef = String(raw.order_ref || "").trim();
    const grossAmount = parseFloat(raw.gross_amount || "0");
    const paymentDate = parseDateToIso(raw.payment_date || raw.date || raw.created_at);
    const status = raw.status ? String(raw.status).trim() : null;

    let resolvedOrderId: string | null = null;
    let paymentUuid: string | null = null;

    // B1. Resolve core.orders linkage via order_ref (matching external_ref or order_number)
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

    // B2. Upsert core.payments
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

    // B3. Generate PAYMENT, FEE, SETTLEMENT events
    const mapped = mapRazorpayTransaction(raw, merchantId, missionId, rec.id, {
      order_id: resolvedOrderId,
      payment_id: paymentUuid,
    });

    mapped.forEach((evt) => {
      allEventsToInsert.push(evt);
      recordEventCount(evt.event_type);
    });
  }

  // --------------------------------------------------------------------------
  // STAGE C: Normalize Bank Transactions
  // --------------------------------------------------------------------------
  for (const rec of bankRecords) {
    const raw = rec.raw_json;
    const mapped = mapBankTransaction(raw, merchantId, missionId, rec.id);

    mapped.forEach((evt) => {
      allEventsToInsert.push(evt);
      recordEventCount(evt.event_type);
    });
  }

  // --------------------------------------------------------------------------
  // 5. Batch Insert into finance.normalized_events
  // --------------------------------------------------------------------------
  const insertBatchSize = 100;
  for (let i = 0; i < allEventsToInsert.length; i += insertBatchSize) {
    const chunk = allEventsToInsert.slice(i, i + insertBatchSize);
    const { error: insertError } = await supabase
      .schema("finance")
      .from("normalized_events")
      .insert(chunk);

    if (insertError) {
      console.error("Error inserting normalized_events chunk:", insertError);
      throw new Error(`Failed to insert normalized events: ${insertError.message}`);
    }
  }

  // 6. Update Mission Status
  // If all documents have extracted records and are normalized, set to 'reconciling'
  const newMissionStatus = "reconciling";
  await supabase
    .schema("finance")
    .from("finance_missions")
    .update({ status: newMissionStatus })
    .eq("id", missionId)
    .eq("merchant_id", merchantId);

  // 7. Write Audit Log
  await writeAuditLog({
    merchant_id: merchantId,
    mission_id: missionId,
    actor_type: "user",
    actor_id: actorUserId || null,
    action: "mission.normalized",
    entity_type: "finance.normalized_events",
    after: {
      events_created: allEventsToInsert.length,
      by_type: byTypeCount,
      processed_records_count: unnormalizedRecords.length,
    },
  });

  return {
    events_created: allEventsToInsert.length,
    by_type: byTypeCount,
    mission_status: newMissionStatus,
    processed_records_count: unnormalizedRecords.length,
  };
}
