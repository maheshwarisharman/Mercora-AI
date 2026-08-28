import { getServiceSupabase } from "../../../shared/db/supabase";
import type { ToolDefinition } from "../../llm/types";

export const getAmazonDeductionContextDefinition: ToolDefinition = {
  name: "get_amazon_deduction_context",
  description:
    "Retrieves verified Amazon settlement context for an exception: the exact line item, its settlement siblings, the original core order when linked, and any Shopify refund event found for the same order. Use this for Amazon unknown codes, weight anomalies, and long-lookback return clawbacks. Do not infer a code meaning from memory when this tool can retrieve the actual row and comparable codes in the mission.",
  parameters: {
    type: "object",
    properties: {
      exception_id: { type: "string", description: "The Amazon exception UUID from finance.exceptions." },
    },
    required: ["exception_id"],
  },
};

function compactEvent(event: any): Record<string, unknown> {
  return {
    id: event.id,
    event_type: event.metadata?.canonical_event_type || event.event_type,
    source_system: event.metadata?.canonical_source_system || event.source_system,
    external_ref: event.external_ref,
    amount: Number(event.amount),
    currency: event.currency,
    event_date: event.event_date,
    order_id: event.order_id,
    batch_ref: event.batch_ref || event.metadata?.batch_ref,
    metadata: event.metadata,
  };
}

export async function getAmazonDeductionContext(args: Record<string, unknown>): Promise<unknown> {
  const exceptionId = String(args.exception_id || "");
  if (!exceptionId) return { error: "exception_id is required" };
  const supabase = getServiceSupabase();
  const { data: exception, error: exceptionError } = await supabase
    .schema("finance").from("exceptions").select("*").eq("id", exceptionId).single();
  if (exceptionError || !exception) return { error: exceptionError?.message || "Exception not found" };

  const eventIds = Array.isArray(exception.normalized_event_ids) ? exception.normalized_event_ids : [];
  const { data: linkedEvents, error: eventsError } = await supabase
    .schema("finance").from("normalized_events").select("*").in("id", eventIds);
  if (eventsError) return { error: eventsError.message };
  const amazonEvent = (linkedEvents || []).find((event: any) =>
    String(event.metadata?.canonical_source_system || event.source_system).toLowerCase() === "amazon"
  );
  if (!amazonEvent) return { error: "This exception has no linked Amazon event." };

  const orderRef = String(amazonEvent.metadata?.order_ref || amazonEvent.external_ref || "").trim();
  const batchRef = String(amazonEvent.batch_ref || amazonEvent.metadata?.amazon_settlement_id || "").trim();
  const { data: missionEvents } = await supabase
    .schema("finance").from("normalized_events").select("*").eq("mission_id", exception.mission_id).order("event_date", { ascending: true });
  const siblings = (missionEvents || []).filter((event: any) =>
    String(event.metadata?.canonical_source_system || event.source_system).toLowerCase() === "amazon" &&
    ((batchRef && String(event.batch_ref || event.metadata?.amazon_settlement_id || "") === batchRef) ||
      (orderRef && String(event.metadata?.order_ref || event.external_ref || "") === orderRef))
  );

  let coreOrder: Record<string, unknown> | null = null;
  if (amazonEvent.order_id) {
    const { data: order } = await supabase.schema("core").from("orders").select("*").eq("id", amazonEvent.order_id).maybeSingle();
    coreOrder = order || null;
  }
  const { data: refundEvents } = await supabase
    .schema("finance").from("normalized_events").select("*").eq("mission_id", exception.mission_id).eq("event_type", "REFUND");
  const knownReturnEvents = (refundEvents || []).filter((event: any) =>
    String(event.metadata?.canonical_source_system || event.source_system).toLowerCase() === "shopify" &&
    ((amazonEvent.order_id && event.order_id === amazonEvent.order_id) ||
      (orderRef && String(event.external_ref || event.metadata?.order_ref || "") === orderRef))
  );

  return {
    exception: { id: exception.id, type: exception.exception_type, expected_amount: Number(exception.expected_amount), actual_amount: Number(exception.actual_amount), difference: Number(exception.difference) },
    amazon_line: compactEvent(amazonEvent),
    settlement_siblings: siblings.map(compactEvent),
    comparable_codes: Array.from(new Set(siblings.map((event: any) => event.metadata?.amount_description).filter(Boolean))),
    core_order: coreOrder,
    known_return_events: knownReturnEvents.map(compactEvent),
    lookback_policy: "Search the full mission history for return evidence; Amazon clawbacks can post 30–90 days after the order.",
  };
}
