import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getLLMProvider } from "../../../shared/llm";
import { runAgentLoop } from "../../../shared/agent/loop";
import {
  getBankCreditDefinition,
  listCandidateBatchesDefinition,
  getNarrationHistoryDefinition,
  createBankCreditToolImplementations,
} from "../../../shared/agent/tools/bankCredit";
import type { AgentTraceStep, LLMProvider } from "../../../shared/llm/types";
import type {
  BankCreditResolution,
  BankCreditResolutionStatus,
} from "./matcher";

const BankCreditDecisionSchema = z.object({
  decision: z.enum(["chosen_candidate", "combined_batches", "insufficient_evidence"]),
  chosen_candidate_id: z.string().nullable(),
  combined_candidate_ids: z.array(z.string()),
  reasoning: z.string(),
});

export type BankCreditDecision = z.infer<typeof BankCreditDecisionSchema>;

export interface BankCreditFallbackResult {
  resolution: BankCreditResolution;
  trace: AgentTraceStep[];
}

function compactCandidate(candidate: BankCreditResolution["candidates"][number]): Record<string, unknown> {
  return {
    candidate_id: candidate.candidate_id,
    batch_reference: candidate.batch_reference,
    source: candidate.source,
    amount: candidate.amount,
    date: candidate.date,
    score: candidate.score,
    signals: candidate.signals,
  };
}

function normalizeDecision(raw: unknown): BankCreditDecision {
  const value = (raw || {}) as Record<string, unknown>;
  const decisionRaw = String(value.decision || value.result || "insufficient_evidence").toLowerCase();
  const decision = decisionRaw.includes("combined") || decisionRaw.includes("net")
    ? "combined_batches"
    : decisionRaw.includes("chosen") || decisionRaw.includes("match")
    ? "chosen_candidate"
    : "insufficient_evidence";
  const chosen = value.chosen_candidate_id ?? value.candidate_id ?? value.chosenCandidateId;
  const combined = value.combined_candidate_ids ?? value.candidate_ids ?? value.combinedCandidateIds;
  return {
    decision,
    chosen_candidate_id: chosen === null || chosen === undefined ? null : String(chosen),
    combined_candidate_ids: Array.isArray(combined) ? combined.map(String) : [],
    reasoning: String(value.reasoning || value.explanation || "The available evidence was insufficient."),
  };
}

/**
 * Runs the fallback only for a resolution that deterministic scoring left
 * ambiguous. The exact ranked list is embedded in the prompt and is the
 * allow-list used by the validation guard below.
 */
export async function runBankCreditFallback(params: {
  resolution: BankCreditResolution;
  merchantId: string;
  missionId: string;
  llmProvider?: LLMProvider;
}): Promise<BankCreditFallbackResult> {
  const { resolution, merchantId, missionId } = params;
  const llm = params.llmProvider || getLLMProvider("investigate");
  const exactCandidateList = resolution.candidates.map(compactCandidate);
  const candidateIds = new Set(resolution.candidates.map((candidate) => candidate.candidate_id));
  const bank = resolution.bank_credit;

  const systemPrompt = `You are the bank-credit disambiguation agent for Mercora.
Choose only from the exact candidate list supplied in the user message.
You may use get_bank_credit, list_candidate_batches, and get_narration_history to inspect real records.
Do not perform arithmetic, create IDs, or invent a batch reference.
If one candidate is not supported by clear evidence, return insufficient_evidence.
If the narration and amount look like two batches netted together, return combined_batches and list only candidate IDs from the supplied list.
The final answer must use decision=chosen_candidate, combined_batches, or insufficient_evidence.`;

  const initialUserMessage = `Disambiguate this unresolved bank credit.
Bank credit ID: ${bank.id}
Amount: ${Number(bank.amount)}
Date: ${bank.event_date}
Narration: ${[bank.external_ref, bank.counterparty, bank.metadata?.description, bank.metadata?.narration].filter(Boolean).join(" ")}

EXACT CANDIDATE LIST (the only IDs that may be returned):
${JSON.stringify(exactCandidateList)}

First fetch the bank credit, then use the candidate and narration-history tools as needed. Do not choose a candidate merely because it has the highest deterministic score; choose it only when the evidence is clear.`;

  const loopResult = await runAgentLoop<BankCreditDecision>({
    systemPrompt,
    initialUserMessage,
    tools: [getBankCreditDefinition, listCandidateBatchesDefinition, getNarrationHistoryDefinition],
    toolImplementations: createBankCreditToolImplementations({ merchantId, missionId }),
    maxSteps: 4,
    finalResponseSchema: zodToJsonSchema(BankCreditDecisionSchema as any, "BankCreditDecision"),
    llmProvider: llm,
    auditContext: {
      merchantId,
      missionId,
      entityType: "finance.normalized_events",
      entityId: bank.id || null,
    },
  });

  const decision = normalizeDecision(loopResult.finalAnswer);
  let status: BankCreditResolutionStatus = "insufficient_evidence";
  let chosenCandidateId: string | null = null;
  let combinedCandidateIds: string[] = [];

  if (decision.decision === "chosen_candidate" && decision.chosen_candidate_id && candidateIds.has(decision.chosen_candidate_id)) {
    status = "llm_resolved";
    chosenCandidateId = decision.chosen_candidate_id;
  } else if (decision.decision === "combined_batches") {
    combinedCandidateIds = decision.combined_candidate_ids.filter((id) => candidateIds.has(id));
    // Do not silently accept a partial or unknown subset from the model.
    if (combinedCandidateIds.length === decision.combined_candidate_ids.length && combinedCandidateIds.length >= 2) {
      status = "combined_batches";
    } else {
      decision.reasoning = "The model returned a combined-batch set that was not wholly present in the exact candidate list.";
    }
  } else if (decision.decision === "chosen_candidate") {
    decision.reasoning = "The model returned a candidate ID that was not present in the exact candidate list.";
  }

  if (decision.decision === "chosen_candidate" && chosenCandidateId === null) {
    console.warn(`[BankCreditDisambiguationGuard] Rejected unlisted candidate for bank=${bank.id || "unknown"}`);
  }

  return {
    trace: loopResult.trace,
    resolution: {
      ...resolution,
      status,
      chosen_candidate_id: chosenCandidateId,
      combined_candidate_ids: combinedCandidateIds,
      resolution_method: status === "llm_resolved" || status === "combined_batches" ? "llm" : "none",
      reasoning: decision.reasoning,
    },
  };
}
