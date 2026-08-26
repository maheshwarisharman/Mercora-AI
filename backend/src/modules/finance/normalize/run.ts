import { getServiceSupabase } from "../../../shared/db/supabase";
import { writeAuditLog } from "../shared/audit";
import { normalizerRegistry } from "./registry";
import type { ExtractedRecord, NormalizedEvent, SourceDocument } from "../shared/types";
import type { NormalizationContext, SourceNormalizerAdapter } from "./types";

export interface NormalizationSummary {
  events_created: number;
  by_type: Record<string, number>;
  mission_status: string;
  processed_records_count: number;
}

/**
 * Orchestrates mission normalization across all unnormalized extracted records
 * using the modular SourceNormalizerAdapter registry.
 * Follows strict priority order defined by adapters (e.g., Shopify -> Razorpay -> COD -> Bank).
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

  // 4. Partition unnormalized records by detected_source
  const recordsBySource = new Map<string, ExtractedRecord[]>();
  for (const record of unnormalizedRecords) {
    const doc = docMap.get(record.source_document_id);
    let source = doc?.detected_source || "unknown";

    // Heuristic fallback for COD courier files if detected_source is unknown
    if (source === "unknown" && doc?.original_filename) {
      const lowerName = doc.original_filename.toLowerCase();
      if (
        lowerName.includes("cod") ||
        lowerName.includes("remittance") ||
        lowerName.includes("delhivery") ||
        lowerName.includes("shiprocket") ||
        lowerName.includes("ecom")
      ) {
        source = "generic_cod";
      }
    }

    const group = recordsBySource.get(source) || [];
    group.push(record);
    recordsBySource.set(source, group);
  }

  // 5. Resolve adapters and sort execution batches by priority
  const executionBatches: Array<{ adapter: SourceNormalizerAdapter; records: ExtractedRecord[] }> = [];

  for (const [source, records] of recordsBySource.entries()) {
    const adapter = normalizerRegistry.get(source);
    if (!adapter) {
      console.warn(`[Normalization] No adapter registered for detected source '${source}'. Skipping ${records.length} records.`);
      continue;
    }
    executionBatches.push({ adapter, records });
  }

  // Sort batches by adapter priority ascending (e.g. 1 -> 2 -> 3 -> 4)
  executionBatches.sort((a, b) => a.adapter.priority - b.adapter.priority);

  // 6. Execute normalization across batches
  const context: NormalizationContext = {
    missionId,
    merchantId,
    supabase,
  };

  const allEventsToInsert: NormalizedEvent[] = [];
  const byTypeCount: Record<string, number> = {};

  for (const { adapter, records } of executionBatches) {
    // Optional adapter-level validation
    if (adapter.validate) {
      const validation = adapter.validate(records);
      if (!validation.valid && validation.recordIssues) {
        console.warn(
          `[Normalization Warning] Adapter '${adapter.detectedSource}' detected validation issues on ${validation.recordIssues.length} records.`
        );
      }
    }

    const events = await adapter.normalize(records, context);
    for (const evt of events) {
      allEventsToInsert.push(evt);
      byTypeCount[evt.event_type] = (byTypeCount[evt.event_type] || 0) + 1;
    }
  }

  // Helper to format event for DB insertion with fallback compatibility
  const sanitizeEventForDb = (evt: NormalizedEvent): Record<string, any> => {
    let dbEventType = evt.event_type;
    if (evt.event_type === "COD_REMITTANCE") dbEventType = "SETTLEMENT" as any;
    else if (evt.event_type === "COD_COLLECTION") dbEventType = "PAYMENT" as any;
    else if (evt.event_type === "COD_DEDUCTION") dbEventType = "FEE" as any;
    else if (evt.event_type === "RTO_EVENT") dbEventType = "ADJUSTMENT" as any;

    const isCourier = evt.source_system === "courier" || evt.source_system === "cod";
    const dbSourceSystem = isCourier ? "vendor" : evt.source_system;

    return {
      mission_id: evt.mission_id,
      merchant_id: evt.merchant_id,
      extracted_record_id: evt.extracted_record_id,
      event_type: dbEventType,
      source_system: dbSourceSystem,
      external_ref: evt.external_ref,
      amount: evt.amount,
      currency: evt.currency || "INR",
      event_date: evt.event_date,
      counterparty: evt.counterparty,
      order_id: evt.order_id,
      payment_id: evt.payment_id,
      customer_id: evt.customer_id,
      metadata: {
        ...evt.metadata,
        canonical_event_type: evt.event_type,
        canonical_source_system: evt.source_system,
        batch_ref: evt.batch_ref,
        order_ids: evt.order_ids,
        deduction_type: evt.deduction_type,
      },
    };
  };

  // 7. Batch Insert into finance.normalized_events
  const insertBatchSize = 100;
  for (let i = 0; i < allEventsToInsert.length; i += insertBatchSize) {
    const chunk = allEventsToInsert.slice(i, i + insertBatchSize);
    const dbRows = chunk.map(sanitizeEventForDb);

    const { error: insertError } = await supabase
      .schema("finance")
      .from("normalized_events")
      .insert(dbRows);

    if (insertError) {
      console.error("Error inserting normalized_events chunk:", insertError);
      throw new Error(`Failed to insert normalized events: ${insertError.message}`);
    }
  }

  // 8. Update Mission Status
  const newMissionStatus = "reconciling";
  await supabase
    .schema("finance")
    .from("finance_missions")
    .update({ status: newMissionStatus })
    .eq("id", missionId)
    .eq("merchant_id", merchantId);

  // 9. Write Audit Log
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
