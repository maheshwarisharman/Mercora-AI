import { getServiceSupabase } from "../../../shared/db/supabase";
import type { ToolDefinition } from "../../llm/types";

export const getExceptionDetailsDefinition: ToolDefinition = {
  name: "get_exception_details",
  description:
    "Retrieves the full detail of a specific reconciliation exception by its ID. " +
    "Returns the exception row (type, expected amount, actual amount, difference, status, " +
    "normalized_event_ids) plus all linked normalized events in the transaction chain. " +
    "Call this as your first step when investigating any exception — it gives you the raw " +
    "discrepancy figures and the chain of events you need to reason about before deciding " +
    "which other tools to call.",
  parameters: {
    type: "object",
    properties: {
      exception_id: {
        type: "string",
        description: "The UUID of the exception to fetch (from finance.exceptions).",
      },
    },
    required: ["exception_id"],
  },
};

export async function getExceptionDetails(args: Record<string, unknown>): Promise<unknown> {
  const exceptionId = String(args.exception_id || "");
  if (!exceptionId) return { error: "exception_id is required" };

  const supabase = getServiceSupabase();

  const { data: exception, error: exErr } = await supabase
    .schema("finance")
    .from("exceptions")
    .select("*")
    .eq("id", exceptionId)
    .single();

  if (exErr || !exception) {
    return { error: exErr?.message || "Exception not found" };
  }

  // Fetch linked normalized events
  const eventIds: string[] = exception.normalized_event_ids || [];
  let linkedEvents: any[] = [];
  if (eventIds.length > 0) {
    const { data: evts } = await supabase
      .schema("finance")
      .from("normalized_events")
      .select("*")
      .in("id", eventIds);
    linkedEvents = evts || [];
  }

  return {
    exception: {
      id: exception.id,
      mission_id: exception.mission_id,
      exception_type: exception.exception_type,
      expected_amount: Number(exception.expected_amount),
      actual_amount: Number(exception.actual_amount),
      difference: Number(exception.difference),
      status: exception.status,
      normalized_event_ids: eventIds,
    },
    linked_events: linkedEvents.map((e: any) => ({
      id: e.id,
      event_type: e.event_type,
      source_system: e.source_system,
      external_ref: e.external_ref,
      amount: Number(e.amount),
      currency: e.currency,
      event_date: e.event_date,
      counterparty: e.counterparty,
      metadata: e.metadata,
    })),
  };
}
