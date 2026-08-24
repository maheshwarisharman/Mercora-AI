import { getServiceSupabase } from "../../../shared/db/supabase";
import { writeAuditLog } from "../shared/audit";
import { matchMissionEvents, type ReconciledChain } from "./matcher";
import { detectMissionExceptions, type DetectedException } from "../exceptions/detect";
import type { NormalizedEvent } from "../shared/types";

export interface ReconcileSummary {
  matches_created: number;
  exceptions_created: number;
  by_type: Record<string, number>;
  mission_status: string;
  matches: ReconciledChain[];
  exceptions: DetectedException[];
}

/**
 * Orchestrates reconciliation and exception detection for a finance mission.
 * Pure deterministic pipeline: fetches normalized events once, runs matcher and
 * exception detector, persists results, writes audit log, and updates mission status.
 */
export async function runMissionReconciliation(params: {
  missionId: string;
  merchantId: string;
  actorUserId?: string | null;
}): Promise<ReconcileSummary> {
  const { missionId, merchantId, actorUserId } = params;
  const supabase = getServiceSupabase();

  // 1. Fetch all normalized events for this mission
  const { data: events, error: eventsError } = await supabase
    .schema("finance")
    .from("normalized_events")
    .select("*")
    .eq("mission_id", missionId)
    .eq("merchant_id", merchantId);

  if (eventsError || !events) {
    throw new Error(`Failed to load normalized events: ${eventsError?.message}`);
  }

  const typedEvents = events as NormalizedEvent[];

  // 2. Run Pure Reconcile Matcher
  const matchResult = matchMissionEvents(typedEvents);

  // 3. Run Pure Exception Detector
  const detectedExceptions = detectMissionExceptions(typedEvents);

  // 4. Clean prior matches and exceptions for idempotency
  await supabase
    .schema("finance")
    .from("matches")
    .delete()
    .eq("mission_id", missionId);

  await supabase
    .schema("finance")
    .from("exceptions")
    .delete()
    .eq("mission_id", missionId);

  // 5. Insert Matches into DB
  if (matchResult.matches.length > 0) {
    const matchRows = matchResult.matches.map((m) => ({
      mission_id: missionId,
      event_ids: m.event_ids,
      match_type: m.match_type,
      confidence: m.confidence,
      signals: m.signals,
      status: m.status,
    }));

    const { error: matchInsertErr } = await supabase
      .schema("finance")
      .from("matches")
      .insert(matchRows);

    if (matchInsertErr) {
      console.error("Error inserting matches:", matchInsertErr);
      throw new Error(`Failed to insert matches: ${matchInsertErr.message}`);
    }
  }

  // 6. Insert Exceptions into DB
  if (detectedExceptions.length > 0) {
    const exceptionRows = detectedExceptions.map((ex) => ({
      mission_id: missionId,
      normalized_event_ids: ex.normalized_event_ids,
      exception_type: ex.exception_type,
      expected_amount: ex.expected_amount,
      actual_amount: ex.actual_amount,
      difference: ex.difference,
      status: ex.status,
    }));

    const { error: exInsertErr } = await supabase
      .schema("finance")
      .from("exceptions")
      .insert(exceptionRows);

    if (exInsertErr) {
      console.error("Error inserting exceptions:", exInsertErr);
      throw new Error(`Failed to insert exceptions: ${exInsertErr.message}`);
    }
  }

  // 7. Calculate Breakdown by Exception Type
  const byType: Record<string, number> = {};
  for (const ex of detectedExceptions) {
    byType[ex.exception_type] = (byType[ex.exception_type] || 0) + 1;
  }

  // 8. Update Mission Status to 'needs_review'
  const newMissionStatus = "needs_review";
  await supabase
    .schema("finance")
    .from("finance_missions")
    .update({ status: newMissionStatus })
    .eq("id", missionId)
    .eq("merchant_id", merchantId);

  // 9. Write Single Audit Log Entry
  await writeAuditLog({
    merchant_id: merchantId,
    mission_id: missionId,
    actor_type: actorUserId ? "user" : "system",
    actor_id: actorUserId || null,
    action: "mission.reconciled",
    entity_type: "finance.matches",
    after: {
      matches_created: matchResult.matches.length,
      exceptions_created: detectedExceptions.length,
      by_type: byType,
    },
  });

  return {
    matches_created: matchResult.matches.length,
    exceptions_created: detectedExceptions.length,
    by_type: byType,
    mission_status: newMissionStatus,
    matches: matchResult.matches,
    exceptions: detectedExceptions,
  };
}
