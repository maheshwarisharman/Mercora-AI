import { getServiceSupabase } from "../../../shared/db/supabase";
import { writeAuditLog } from "../shared/audit";
import { matchMissionEvents, type ReconciledChain, type BankCreditResolution, type BankCreditDisambiguationConfig } from "./matcher";
import { runBankCreditFallback } from "./disambiguate";
import { detectMissionExceptions, type DetectedException } from "../exceptions/detect";
import type { NormalizedEvent } from "../shared/types";

export interface ReconcileSummary {
  matches_created: number;
  exceptions_created: number;
  by_type: Record<string, number>;
  mission_status: string;
  matches: ReconciledChain[];
  exceptions: DetectedException[];
  bank_credits_resolved_deterministically: number;
  bank_credits_escalated: number;
}

async function persistBankCreditCandidates(params: {
  missionId: string;
  resolutions: ReturnType<typeof matchMissionEvents>["bank_credit_resolutions"];
}): Promise<void> {
  const { missionId, resolutions } = params;
  const supabase = getServiceSupabase();
  const { error: deleteError } = await supabase
    .schema("finance")
    .from("bank_credit_candidates")
    .delete()
    .eq("mission_id", missionId);
  if (deleteError) throw new Error(`Failed to clear bank credit candidates: ${deleteError.message}`);

  const rows = resolutions.flatMap((resolution) => resolution.candidates.map((candidate) => ({
    mission_id: missionId,
    bank_credit_id: resolution.bank_credit.id,
    candidate_event_id: candidate.candidate_id,
    batch_ref: candidate.batch_reference || candidate.candidate_id,
    source: candidate.source,
    score: candidate.score,
    amount: candidate.amount,
    event_date: candidate.date,
    signals: candidate.signals,
    resolution_status: resolution.status,
  })));
  if (rows.length === 0) return;
  const { error } = await supabase.schema("finance").from("bank_credit_candidates").insert(rows);
  if (error) throw new Error(`Failed to persist bank credit candidates: ${error.message}`);
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
  bankCreditDisambiguation?: BankCreditDisambiguationConfig;
}): Promise<ReconcileSummary> {
  const { missionId, merchantId, actorUserId, bankCreditDisambiguation } = params;
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

  // 2. Clean prior matches and exceptions for idempotency. This also makes
  // list_candidate_batches reflect the current run's unmatched state.
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

  // 3. Run the pure deterministic stage first.
  const envNumber = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
  };
  const disambiguationConfig = bankCreditDisambiguation || {
    minimumConfidence: envNumber("BANK_CREDIT_MIN_CONFIDENCE", 70),
    minimumMargin: envNumber("BANK_CREDIT_MIN_MARGIN", 15),
    amountToleranceRupees: envNumber("BANK_CREDIT_AMOUNT_TOLERANCE", 1),
  };
  let matchResult = matchMissionEvents(typedEvents, { bankCreditDisambiguation: disambiguationConfig });
  await persistBankCreditCandidates({ missionId, resolutions: matchResult.bank_credit_resolutions });
  console.info(
    `[BankCreditDisambiguation] mission=${missionId} deterministic=${matchResult.bank_credit_resolutions.filter((r) => r.status === "deterministic").length} ` +
    `ambiguous=${matchResult.bank_credit_resolutions.filter((r) => r.status !== "deterministic").length}`
  );

  const llmAssignments: Record<string, string> = {};
  const llmCombinedAssignments: Record<string, string[]> = {};
  const fallbackResolutions = new Map<string, BankCreditResolution>();
  const llmCandidateIds = new Set<string>();
  const deterministicCandidateIds = new Set(
    matchResult.bank_credit_resolutions
      .filter((resolution) => resolution.status === "deterministic" && resolution.chosen_candidate_id)
      .map((resolution) => resolution.chosen_candidate_id as string)
  );
  for (const resolution of matchResult.bank_credit_resolutions) {
    if (resolution.status !== "ambiguous") continue;
    try {
      const fallback = await runBankCreditFallback({
        resolution,
        merchantId,
        missionId,
      });
      fallbackResolutions.set(String(resolution.bank_credit.id), fallback.resolution);
      if (
        fallback.resolution.status === "llm_resolved" &&
        fallback.resolution.chosen_candidate_id &&
        !deterministicCandidateIds.has(fallback.resolution.chosen_candidate_id) &&
        !llmCandidateIds.has(fallback.resolution.chosen_candidate_id) &&
        resolution.bank_credit.id
      ) {
        llmAssignments[resolution.bank_credit.id] = fallback.resolution.chosen_candidate_id;
        llmCandidateIds.add(fallback.resolution.chosen_candidate_id);
      } else if (
        fallback.resolution.status === "combined_batches" &&
        fallback.resolution.combined_candidate_ids &&
        fallback.resolution.combined_candidate_ids.length >= 2 &&
        resolution.bank_credit.id
      ) {
        const combinedCandidateIds = fallback.resolution.combined_candidate_ids;
        const conflicts = combinedCandidateIds.some((candidateId) =>
          deterministicCandidateIds.has(candidateId) || llmCandidateIds.has(candidateId)
        );
        if (!conflicts) {
          llmCombinedAssignments[resolution.bank_credit.id] = combinedCandidateIds;
          combinedCandidateIds.forEach((candidateId) => llmCandidateIds.add(candidateId));
        } else {
          fallback.resolution.status = "insufficient_evidence";
          fallback.resolution.combined_candidate_ids = [];
          fallback.resolution.reasoning = "The selected combined candidates overlap another bank-credit assignment.";
        }
      } else if (
        fallback.resolution.status === "llm_resolved" &&
        fallback.resolution.chosen_candidate_id &&
        (deterministicCandidateIds.has(fallback.resolution.chosen_candidate_id) || llmCandidateIds.has(fallback.resolution.chosen_candidate_id))
      ) {
        fallback.resolution.status = "insufficient_evidence";
        fallback.resolution.chosen_candidate_id = null;
        fallback.resolution.resolution_method = "none";
        fallback.resolution.reasoning = "The selected candidate is already assigned to another bank credit.";
      }
    } catch (error: any) {
      console.error(`[BankCreditDisambiguation] LLM fallback failed for bank=${resolution.bank_credit.id}:`, error);
      fallbackResolutions.set(String(resolution.bank_credit.id), {
        ...resolution,
        status: "insufficient_evidence",
        chosen_candidate_id: null,
        resolution_method: "none",
        reasoning: error?.message || "LLM fallback failed",
      });
    }
  }

  // Re-run the pure matcher with only validated LLM assignments. The matcher
  // never receives an unlisted candidate ID.
  if (Object.keys(llmAssignments).length > 0 || Object.keys(llmCombinedAssignments).length > 0) {
    matchResult = matchMissionEvents(typedEvents, {
      bankCreditAssignments: llmAssignments,
      bankCreditCombinedAssignments: llmCombinedAssignments,
      bankCreditDisambiguation: disambiguationConfig,
    });
  }
  for (const resolution of matchResult.bank_credit_resolutions) {
    const fallback = fallbackResolutions.get(String(resolution.bank_credit.id));
    if (!fallback || fallback.status === "llm_resolved") continue;
    resolution.status = fallback.status;
    resolution.chosen_candidate_id = fallback.chosen_candidate_id;
    resolution.combined_candidate_ids = fallback.combined_candidate_ids;
    resolution.resolution_method = fallback.resolution_method;
    resolution.reasoning = fallback.reasoning;
  }
  await persistBankCreditCandidates({ missionId, resolutions: matchResult.bank_credit_resolutions });

  // 4. Run exception detection after fallback. Unresolved credits become
  // AMBIGUOUS_BANK_CREDIT and are excluded from guessed chain exceptions.
  const matchedBankEventIds = new Set(
    matchResult.matches.map((match) => match.events.bank?.id).filter((id): id is string => Boolean(id))
  );
  const detectedExceptions = detectMissionExceptions(typedEvents, {
    bankCreditResolutions: matchResult.bank_credit_resolutions,
    matchedBankEventIds,
  });

  for (const resolution of matchResult.bank_credit_resolutions) {
    await writeAuditLog({
      merchant_id: merchantId,
      mission_id: missionId,
      actor_type: resolution.resolution_method === "llm" ? "gemini" : "system",
      actor_id: resolution.resolution_method === "llm" ? "gemini" : null,
      action: "bank_credit.disambiguated",
      entity_type: "finance.normalized_events",
      entity_id: resolution.bank_credit.id || null,
      after: {
        status: resolution.status,
        resolution_method: resolution.resolution_method,
        chosen_candidate_id: resolution.chosen_candidate_id,
        confidence: resolution.confidence,
        margin: resolution.margin,
        candidate_count: resolution.candidates.length,
        candidates: resolution.candidates.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          batch_reference: candidate.batch_reference,
          source: candidate.source,
          score: candidate.score,
          amount: candidate.amount,
          date: candidate.date,
        })),
        reasoning: resolution.reasoning,
      },
    });
  }

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
    bank_credits_resolved_deterministically: matchResult.bank_credit_resolutions.filter((r) => r.status === "deterministic").length,
    bank_credits_escalated: matchResult.bank_credit_resolutions.filter((r) =>
      ["ambiguous", "no_candidates", "combined_batches", "insufficient_evidence"].includes(r.status)
    ).length,
  };
}
