import { getServiceSupabase } from "../../../shared/db/supabase";
import type { ToolDefinition } from "../../llm/types";

export const getAmazonDeductionContextDefinition: ToolDefinition = {
  name: "get_amazon_deduction_context",
  description:
    "Retrieves verified Amazon settlement context for an exception, settlement ID (e.g. 'AMZ-DEMO-2026-08-001'), or order reference: the exact line items, deduction breakdown, settlement siblings, the original core order when linked, and any Shopify refund event found for the same order. Use this for Amazon unknown codes, weight anomalies, return clawbacks, and settlement vs bank differences. Do not infer a code meaning from memory when this tool can retrieve the actual rows and comparable codes in the mission.",
  parameters: {
    type: "object",
    properties: {
      exception_id: { type: "string", description: "The Amazon exception UUID from finance.exceptions (optional if settlement_id or order_ref is provided)." },
      settlement_id: { type: "string", description: "The Amazon settlement ID (e.g. 'AMZ-DEMO-2026-08-001') (optional if exception_id is provided)." },
      order_ref: { type: "string", description: "The Amazon or merchant order reference (e.g. '#MRC-24025') (optional if exception_id or settlement_id is provided)." },
    },
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
    batch_ref: event.batch_ref || event.metadata?.batch_ref || event.metadata?.amazon_settlement_id,
    deduction_type: event.deduction_type || event.metadata?.deduction_category,
    amount_description: event.metadata?.amount_description,
    amount_type: event.metadata?.amount_type,
    metadata: event.metadata,
  };
}

export async function getAmazonDeductionContext(
  args: Record<string, unknown>,
  context?: { merchantId?: string; missionId?: string },
): Promise<unknown> {
  const exceptionId = String(args.exception_id || "").trim();
  const settlementId = String(args.settlement_id || args.settlementId || "").trim();
  const orderRefArg = String(args.order_ref || args.orderRef || "").trim();

  const ref = settlementId || orderRefArg || exceptionId;
  if (!ref) return { error: "exception_id, settlement_id, or order_ref is required" };

  const supabase = getServiceSupabase();
  const missionId = context?.missionId;

  // 1. Try resolving as exception UUID first if it looks like a UUID
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exceptionId);
  let exception: any = null;
  if (isUuid) {
    let exceptionQuery = supabase.schema("finance").from("exceptions").select("*").eq("id", exceptionId);
    if (missionId) exceptionQuery = exceptionQuery.eq("mission_id", missionId);
    const { data } = await exceptionQuery.maybeSingle();
    exception = data || null;
  }

  const effectiveMissionId = exception?.mission_id || missionId;
  if (!effectiveMissionId) return { error: "mission_id is required" };

  let amazonEvent: any = null;
  let siblings: any[] = [];

  if (exception) {
    const eventIds = Array.isArray(exception.normalized_event_ids) ? exception.normalized_event_ids : [];
    const { data: linkedEvents } = await supabase
      .schema("finance").from("normalized_events").select("*").in("id", eventIds);
    amazonEvent = (linkedEvents || []).find((event: any) =>
      String(event.metadata?.canonical_source_system || event.source_system).toLowerCase() === "amazon"
    );

    const orderRef = String(amazonEvent?.metadata?.order_ref || amazonEvent?.external_ref || "").trim();
    const batchRef = String(amazonEvent?.batch_ref || amazonEvent?.metadata?.amazon_settlement_id || "").trim();

    const { data: missionEvents } = await supabase
      .schema("finance").from("normalized_events").select("*").eq("mission_id", effectiveMissionId).order("event_date", { ascending: true });
    siblings = (missionEvents || []).filter((event: any) =>
      String(event.metadata?.canonical_source_system || event.source_system).toLowerCase() === "amazon" &&
      ((batchRef && String(event.batch_ref || event.metadata?.amazon_settlement_id || "") === batchRef) ||
        (orderRef && String(event.metadata?.order_ref || event.external_ref || "") === orderRef))
    );
  } else {
    // Lookup by settlement ID, order reference, or query string
    const targetRef = settlementId || orderRefArg || exceptionId;
    const { data: missionEvents } = await supabase
      .schema("finance")
      .from("normalized_events")
      .select("*")
      .eq("mission_id", effectiveMissionId)
      .order("event_date", { ascending: true });

    const allAmazonEvents = (missionEvents || []).filter((event: any) =>
      String(event.metadata?.canonical_source_system || event.source_system).toLowerCase() === "amazon"
    );

    siblings = allAmazonEvents.filter((event: any) => {
      const bRef = String(event.batch_ref || event.metadata?.amazon_settlement_id || "");
      const oRef = String(event.metadata?.order_ref || event.metadata?.order_number || event.metadata?.merchant_order_id || event.metadata?.amazon_order_id || "");
      const extRef = String(event.external_ref || "");
      return (
        (bRef && bRef.toLowerCase() === targetRef.toLowerCase()) ||
        (oRef && oRef.toLowerCase() === targetRef.toLowerCase()) ||
        extRef.toLowerCase().includes(targetRef.toLowerCase())
      );
    });

    if (siblings.length === 0 && allAmazonEvents.length > 0) {
      siblings = allAmazonEvents;
    }

    amazonEvent = siblings.find((e) => e.event_type === "AMAZON_SETTLEMENT" || e.event_type === "SETTLEMENT") || siblings[0];
  }

  if (!amazonEvent && siblings.length === 0) {
    return { error: `No Amazon settlement data found for reference "${ref}".` };
  }

  const primaryEvent = amazonEvent || siblings[0];
  const orderRef = String(primaryEvent.metadata?.order_ref || primaryEvent.external_ref || "").trim();

  let coreOrder: Record<string, unknown> | null = null;
  if (primaryEvent.order_id) {
    const { data: order } = await supabase.schema("core").from("orders").select("*").eq("id", primaryEvent.order_id).maybeSingle();
    coreOrder = order || null;
  }
  const { data: refundEvents } = await supabase
    .schema("finance").from("normalized_events").select("*").eq("mission_id", effectiveMissionId).eq("event_type", "REFUND");
  const knownReturnEvents = (refundEvents || []).filter((event: any) =>
    String(event.metadata?.canonical_source_system || event.source_system).toLowerCase() === "shopify" &&
    ((primaryEvent.order_id && event.order_id === primaryEvent.order_id) ||
      (orderRef && String(event.external_ref || event.metadata?.order_ref || "") === orderRef))
  );

  const deductionsBreakdown = siblings
    .filter((e) => e.metadata?.is_deduction || e.event_type === "FEE" || e.event_type === "REFUND")
    .map((e) => ({
      id: e.id,
      external_ref: e.external_ref,
      order_ref: e.metadata?.order_ref || e.metadata?.order_number,
      code: e.metadata?.amount_description || e.metadata?.amount_type || "Fee",
      category: e.metadata?.deduction_category || e.deduction_type,
      label: e.metadata?.deduction_label || e.metadata?.amount_description,
      amount: Number(e.amount),
      is_statutory: Boolean(e.metadata?.is_statutory_withholding),
    }));

  return {
    exception: exception
      ? { id: exception.id, type: exception.exception_type, expected_amount: Number(exception.expected_amount), actual_amount: Number(exception.actual_amount), difference: Number(exception.difference) }
      : null,
    amazon_line: compactEvent(primaryEvent),
    settlement_siblings: siblings.map(compactEvent),
    deductions_breakdown: deductionsBreakdown,
    comparable_codes: Array.from(new Set(siblings.map((event: any) => event.metadata?.amount_description).filter(Boolean))),
    core_order: coreOrder,
    known_return_events: knownReturnEvents.map(compactEvent),
    evidence_refs: Array.from(new Set([
      primaryEvent.id,
      primaryEvent.external_ref,
      ...siblings.flatMap((event: any) => [event.id, event.external_ref]),
    ].filter(Boolean))),
    lookback_policy: "Search the full mission history for return evidence; Amazon clawbacks can post 30–90 days after the order.",
  };
}

