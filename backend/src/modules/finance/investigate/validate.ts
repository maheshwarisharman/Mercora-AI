import type { AgentTraceStep } from "../../../shared/llm/types";
import type { EvidenceResult } from "../../../shared/agent/tools/searchEvidence";

/**
 * Validates that each cited evidence source_ref appeared in a search_evidence
 * tool result during *this specific loop run* — not just in the database.
 *
 * This is the per-spec hallucination guard: an agent that cites something it
 * never looked up is fabricating, even if that thing happens to be real data.
 */
export function validateEvidenceAgainstTrace(params: {
  citedSourceRefs: string[];
  trace: AgentTraceStep[];
}): { validRefs: string[]; droppedRefs: string[] } {
  const { citedSourceRefs, trace } = params;

  // Collect all source_refs that appeared in a search_evidence result this run
  const seenSourceRefs = new Set<string>();

  for (const step of trace) {
    if (step.toolName !== "search_evidence") continue;
    const result = step.result as any;
    if (!result?.results || !Array.isArray(result.results)) continue;
    for (const item of result.results as EvidenceResult[]) {
      if (item.source_ref) seenSourceRefs.add(item.source_ref);
    }
  }

  const validRefs: string[] = [];
  const droppedRefs: string[] = [];

  for (const ref of citedSourceRefs) {
    if (seenSourceRefs.has(ref)) {
      validRefs.push(ref);
    } else {
      console.warn(
        `[HallucinationGuard] Dropping cited evidence ref "${ref}" — it did not appear in any search_evidence result this run.`
      );
      droppedRefs.push(ref);
    }
  }

  return { validRefs, droppedRefs };
}

/**
 * Validates cited evidence DB UUIDs against a set of known valid IDs.
 * Used after inserting evidence rows — the cited IDs in the judgment must
 * map to rows that actually exist in finance.evidence for this exception.
 */
export function validateEvidenceIds(params: {
  citedIds: string[];
  validIdSet: Set<string>;
}): { validIds: string[]; droppedIds: string[] } {
  const { citedIds, validIdSet } = params;

  const validIds: string[] = [];
  const droppedIds: string[] = [];

  for (const id of citedIds) {
    if (validIdSet.has(id)) {
      validIds.push(id);
    } else {
      console.warn(
        `[HallucinationGuard] Dropping cited evidence UUID "${id}" — not found in finance.evidence for this exception.`
      );
      droppedIds.push(id);
    }
  }

  return { validIds, droppedIds };
}
