import { getServiceSupabase } from "../../../shared/db/supabase";
import { writeAuditLog } from "../../../modules/finance/shared/audit";
import type { ToolDefinition } from "../../llm/types";

export const requestHumanReviewDefinition: ToolDefinition = {
  name: "request_human_review",
  description:
    "Escalates a specific exception for human review when evidence is insufficient or ambiguous. " +
    "This is a real action — it sets the exception's status to 'requires_human_review' and records " +
    "the model's stated reason in the audit log. " +
    "Call this instead of guessing when you have genuinely explored available evidence (via " +
    "get_exception_details, get_transaction_chain, search_evidence) and cannot reach a confident " +
    "classification. Do NOT call this preemptively before investigating — only after at least one " +
    "evidence search has been attempted and found insufficient. " +
    "This is not a fallback for laziness; it is the honest answer when evidence is truly weak.",
  parameters: {
    type: "object",
    properties: {
      exception_id: {
        type: "string",
        description: "UUID of the exception to escalate.",
      },
      reason: {
        type: "string",
        description:
          "A specific, factual explanation of why human review is needed. " +
          "Mention what you looked for and why it was insufficient — e.g. " +
          "'Search returned no matching tickets or refund records for ₹1200 variance on SHF-2045. " +
          "No order ref found in linked events to trace further.'",
      },
    },
    required: ["exception_id", "reason"],
  },
};

export async function requestHumanReview(
  args: Record<string, unknown>,
  context?: { merchantId?: string; missionId?: string }
): Promise<unknown> {
  const exceptionId = String(args.exception_id || "");
  const reason = String(args.reason || "");

  if (!exceptionId) return { error: "exception_id is required" };
  if (!reason) return { error: "reason is required" };

  const supabase = getServiceSupabase();

  // Fetch exception to get mission context
  const { data: exception, error: fetchErr } = await supabase
    .schema("finance")
    .from("exceptions")
    .select("id, mission_id, exception_type, difference")
    .eq("id", exceptionId)
    .single();

  if (fetchErr || !exception) {
    return { error: fetchErr?.message || "Exception not found" };
  }

  // Set status to requires_human_review
  const { error: updateErr } = await supabase
    .schema("finance")
    .from("exceptions")
    .update({ status: "requires_human_review" })
    .eq("id", exceptionId);

  if (updateErr) {
    return { error: `Failed to update exception status: ${updateErr.message}` };
  }

  // Write audit entry with the model's stated reason
  await writeAuditLog({
    merchant_id: context?.merchantId || "unknown",
    mission_id: exception.mission_id,
    actor_type: "gemini",
    action: "exception.escalated_for_human_review",
    entity_type: "finance.exceptions",
    entity_id: exceptionId,
    before: { status: "investigating" },
    after: {
      status: "requires_human_review",
      reason,
      exception_type: exception.exception_type,
      difference: Number(exception.difference),
    },
  });

  return {
    success: true,
    exception_id: exceptionId,
    new_status: "requires_human_review",
    reason,
    message:
      "Exception has been escalated for human review. The audit log has been updated with the stated reason.",
  };
}
