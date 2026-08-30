import { getServiceSupabase } from "../../../shared/db/supabase";
import type { ToolDefinition } from "../../llm/types";

export const getMissionSummaryDefinition: ToolDefinition = {
  name: "get_mission_summary",
  description:
    "Returns aggregate statistics for a reconciliation mission: total events ingested, " +
    "number matched, breakdown by exception type, and total unresolved exposure amount (sum of " +
    "differences on open/investigating exceptions). All figures are computed directly by Postgres — " +
    "not estimated. Call this when the user asks a high-level question about a mission's health " +
    "('how much is unresolved this month?', 'how many exceptions do we have?') rather than about " +
    "a specific exception.",
  parameters: {
    type: "object",
    properties: {
      mission_id: {
        type: "string",
        description: "Optional mission UUID. The server injects the current mission automatically.",
      },
    },
    required: [],
  },
};

export async function getMissionSummary(args: Record<string, unknown>): Promise<unknown> {
  const missionId = String(args.mission_id || "");
  if (!missionId) return { error: "mission_id is required" };

  const supabase = getServiceSupabase();

  // Total events for this mission
  const { count: totalEvents } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select("*", { count: "exact", head: true })
    .eq("mission_id", missionId);

  // Total matches
  const { count: totalMatches } = await supabase
    .schema("finance")
    .from("matches")
    .select("*", { count: "exact", head: true })
    .eq("mission_id", missionId);

  // All exceptions for this mission
  const { data: exceptions, error: exErr } = await supabase
    .schema("finance")
    .from("exceptions")
    .select("exception_type, status, difference")
    .eq("mission_id", missionId);

  if (exErr) return { error: exErr.message };

  const exceptionList = exceptions || [];

  // Breakdown by exception type
  const byType: Record<string, number> = {};
  for (const ex of exceptionList) {
    byType[ex.exception_type] = (byType[ex.exception_type] || 0) + 1;
  }

  // Unresolved exposure = sum of |difference| on open or investigating exceptions
  const unresolvedExposure = exceptionList
    .filter((ex) => ex.status === "open" || ex.status === "investigating")
    .reduce((sum, ex) => sum + Math.abs(Number(ex.difference) || 0), 0);

  return {
    mission_id: missionId,
    total_events: totalEvents || 0,
    total_matches: totalMatches || 0,
    total_exceptions: exceptionList.length,
    by_exception_type: byType,
    unresolved_exposure_inr: Number(unresolvedExposure.toFixed(2)),
    exceptions_by_status: {
      open: exceptionList.filter((e) => e.status === "open").length,
      investigating: exceptionList.filter((e) => e.status === "investigating").length,
      explained: exceptionList.filter((e) => e.status === "explained").length,
      requires_human_review: exceptionList.filter((e) => e.status === "requires_human_review").length,
      resolved: exceptionList.filter((e) => e.status === "resolved").length,
    },
  };
}
