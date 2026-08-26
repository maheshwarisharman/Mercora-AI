import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getServiceSupabase } from "../../../shared/db/supabase";
import { getLLMProvider } from "../../../shared/llm";
import { runAgentLoop } from "../../../shared/agent/loop";
import { financeToolDefinitions, createFinanceToolImplementations } from "../../../shared/agent/tools/registry";
import type { AgentMessage, AgentTraceStep } from "../../../shared/llm/types";

// ─── Final answer schema for Q&A ──────────────────────────────────────────────

const QAAnswerSchema = z.object({
  answer: z.string().describe("The agent's answer to the merchant's question, in plain language."),
  cited_exception_ids: z
    .array(z.string())
    .describe("UUIDs of exceptions referenced in the answer — must have been retrieved via a tool call."),
  cited_evidence_ids: z
    .array(z.string())
    .describe("source_refs of evidence items mentioned — must have appeared in search_evidence results."),
  could_not_answer: z
    .boolean()
    .optional()
    .describe("Set to true if the question is out of scope, nonsensical, or unanswerable with available tools."),
});

export type QAAnswer = z.infer<typeof QAAnswerSchema>;

export interface QAResult {
  answer: string;
  citedExceptionIds: string[];
  citedEvidenceIds: string[];
  couldNotAnswer: boolean;
  trace: AgentTraceStep[];
  hitStepBudget: boolean;
  updatedConversationHistory: AgentMessage[];
}

/**
 * Runs the settlement Q&A agent for a specific mission.
 * Uses the same runAgentLoop as exception investigation — one loop, two entry points.
 *
 * Conversation state is stateless server-side: the frontend sends the full
 * conversationHistory each time and gets back updatedConversationHistory.
 */
export async function runSettlementQA(params: {
  missionId: string;
  merchantId: string;
  question: string;
  conversationHistory?: AgentMessage[];
}): Promise<QAResult> {
  const { missionId, merchantId, question, conversationHistory = [] } = params;

  const supabase = getServiceSupabase();

  // Fetch mission for context
  const { data: mission, error: mErr } = await supabase
    .schema("finance")
    .from("finance_missions")
    .select("id, period_start, period_end, objective, status")
    .eq("id", missionId)
    .single();

  const missionContext = mission
    ? `Mission ${missionId.slice(0, 8)} | Period: ${mission.period_start} → ${mission.period_end} | Objective: ${mission.objective || "Financial reconciliation"} | Status: ${mission.status}`
    : `Mission ${missionId.slice(0, 8)}`;

  const llm = getLLMProvider("judge");

  const systemPrompt = `You are the Mercora Settlement Q&A Agent — a finance analyst assistant for merchants.

You answer questions about a specific reconciliation mission's financial state.
${missionContext}

AVAILABLE TOOLS:
- list_open_exceptions: See what exceptions are still open and need attention.
- get_exception_details: Get the full detail of a specific exception.
- get_bank_credit / list_candidate_batches / get_narration_history: Inspect bank-credit assignments and confirmed narration precedents.
- get_transaction_chain: Trace the payment chain for a specific order.
- search_evidence: Search for supporting documentation (tickets, refund records).
- get_mission_summary: Get aggregate statistics for this mission.
- request_human_review: Escalate a specific exception if asked to do so.

ANSWERING PROTOCOL:
1. For questions about "what needs my attention" or "what's open" → use list_open_exceptions.
2. For questions about a specific transaction or order → use get_transaction_chain.
3. For questions about overall mission health → use get_mission_summary.
4. For out-of-scope questions (weather, sports, general knowledge) → set could_not_answer: true and explain clearly that you only answer questions about this mission's reconciliation data.
5. Never make up numbers, dates, or exception details — only cite what your tools returned.

CRITICAL RULES:
- Do not state anything you didn't verify via a tool call.
- could_not_answer must be true for questions with no connection to finance reconciliation.
- cited_exception_ids must only contain IDs returned by your tools this session.
- cited_evidence_ids must only contain source_refs returned by search_evidence this session.`;

  const finalResponseSchema = zodToJsonSchema(QAAnswerSchema as any, "QAAnswer");

  const loopResult = await runAgentLoop<QAAnswer>({
    systemPrompt,
    initialUserMessage: question,
    conversationHistory,
    tools: financeToolDefinitions,
    toolImplementations: createFinanceToolImplementations({ merchantId, missionId }),
    maxSteps: 6,
    finalResponseSchema,
    llmProvider: llm,
    auditContext: {
      merchantId,
      missionId,
      entityType: "finance.finance_missions",
      entityId: missionId,
    },
  });

  const raw = loopResult.finalAnswer as Record<string, any>;
  const answer = raw.answer ?? raw.response ?? "";
  const citedExceptionIds: string[] = raw.cited_exception_ids ?? raw.citedExceptionIds ?? [];
  const citedEvidenceIds: string[] = raw.cited_evidence_ids ?? raw.citedEvidenceIds ?? [];
  const couldNotAnswer = Boolean(raw.could_not_answer ?? raw.couldNotAnswer ?? false);

  return {
    answer,
    citedExceptionIds,
    citedEvidenceIds,
    couldNotAnswer,
    trace: loopResult.trace,
    hitStepBudget: loopResult.hitStepBudget,
    updatedConversationHistory: loopResult.conversationHistory,
  };
}
