import { getServiceSupabase } from "../../../shared/db/supabase";
import type { ToolDefinition } from "../../llm/types";

export const listOpenExceptionsDefinition: ToolDefinition = {
  name: "list_open_exceptions",
  description:
    "Lists open (unresolved) exceptions for a reconciliation mission. Returns exceptions with " +
    "status 'open' or 'investigating', including their type, discrepancy amount, and current status. " +
    "Optionally filter by exception_type (e.g. 'unexplained_difference', 'timing_difference', " +
    "'gateway_fee', 'missing_settlement') and minimum discrepancy amount. " +
    "Call this when the user asks 'what needs my attention', 'what's still open', or any " +
    "question about outstanding items requiring action. Results are sorted by discrepancy amount " +
    "descending so the highest-impact items appear first.",
  parameters: {
    type: "object",
    properties: {
      mission_id: {
        type: "string",
        description: "UUID of the finance mission to query.",
      },
      filters: {
        type: "object",
        description: "Optional filters.",
        properties: {
          exception_type: {
            type: "string",
            description:
              "Filter to a specific exception type: 'timing_difference', 'gateway_fee', " +
              "'refund', 'partial_refund', 'duplicate', 'missing_settlement', " +
              "'missing_bank_credit', 'unexplained_difference'.",
          },
          min_difference: {
            type: "number",
            description: "Only return exceptions where |difference| >= this value (in INR).",
          },
        },
      },
    },
    required: ["mission_id"],
  },
};

export async function listOpenExceptions(args: Record<string, unknown>): Promise<unknown> {
  const missionId = String(args.mission_id || "");
  if (!missionId) return { error: "mission_id is required" };

  const filters = (args.filters || {}) as {
    exception_type?: string;
    min_difference?: number;
  };

  const supabase = getServiceSupabase();

  let query = supabase
    .schema("finance")
    .from("exceptions")
    .select("id, exception_type, expected_amount, actual_amount, difference, status, created_at")
    .eq("mission_id", missionId)
    .in("status", ["open", "investigating"])
    .order("difference", { ascending: false });

  if (filters.exception_type) {
    query = query.eq("exception_type", filters.exception_type);
  }

  const { data: exceptions, error } = await query;
  if (error) return { error: error.message };

  let results = (exceptions || []).map((ex: any) => ({
    id: ex.id,
    exception_type: ex.exception_type,
    expected_amount: Number(ex.expected_amount),
    actual_amount: Number(ex.actual_amount),
    difference: Number(ex.difference),
    status: ex.status,
    created_at: ex.created_at,
  }));

  // Apply min_difference filter in application layer (absolute value)
  if (filters.min_difference !== undefined && filters.min_difference > 0) {
    results = results.filter((ex) => Math.abs(ex.difference) >= filters.min_difference!);
  }

  return {
    mission_id: missionId,
    count: results.length,
    exceptions: results,
  };
}
