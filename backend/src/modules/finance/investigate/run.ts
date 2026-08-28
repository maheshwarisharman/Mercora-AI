import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getServiceSupabase } from "../../../shared/db/supabase";
import { getLLMProvider } from "../../../shared/llm";
import { runAgentLoop } from "../../../shared/agent/loop";
import { financeToolDefinitions, createFinanceToolImplementations } from "../../../shared/agent/tools/registry";
import type { AgentTraceStep } from "../../../shared/llm/types";
import { writeAuditLog } from "../shared/audit";
import { validateEvidenceAgainstTrace, validateEvidenceIds } from "./validate";

// ─── Final answer schema (same contract as Batch 4) ───────────────────────────

const JudgmentClassificationEnum = z.enum([
  "MATCHED",
  "MATCHED_WITH_ADJUSTMENT",
  "TIMING_DIFFERENCE",
  "FEE",
  "REFUND",
  "DUPLICATE",
  "MISSING_RECORD",
  "UNEXPLAINED",
  "REQUIRES_HUMAN_REVIEW",
]);

export type JudgmentClassification = z.infer<typeof JudgmentClassificationEnum>;

export const VALID_CLASSIFICATIONS = [
  "MATCHED",
  "MATCHED_WITH_ADJUSTMENT",
  "TIMING_DIFFERENCE",
  "FEE",
  "REFUND",
  "DUPLICATE",
  "MISSING_RECORD",
  "UNEXPLAINED",
  "REQUIRES_HUMAN_REVIEW",
] as const;

export function normalizeClassification(raw: unknown): JudgmentClassification {
  if (!raw || typeof raw !== "string") {
    return "REQUIRES_HUMAN_REVIEW";
  }

  const cleaned = raw.toUpperCase().trim().replace(/[\s-]+/g, "_");

  if ((VALID_CLASSIFICATIONS as readonly string[]).includes(cleaned)) {
    return cleaned as JudgmentClassification;
  }

  if (cleaned.includes("TIMING") || cleaned.includes("DELAY")) {
    return "TIMING_DIFFERENCE";
  }
  if (cleaned.includes("ADJUSTMENT") || cleaned.includes("GOODWILL") || cleaned.includes("MATCHED_WITH")) {
    return "MATCHED_WITH_ADJUSTMENT";
  }
  if (cleaned.includes("FEE") || cleaned.includes("CHARGE")) {
    return "FEE";
  }
  if (cleaned.includes("REFUND") || cleaned.includes("RETURN")) {
    return "REFUND";
  }
  if (cleaned.includes("DUPLICATE") || cleaned.includes("DUPLICATION")) {
    return "DUPLICATE";
  }
  if (cleaned.includes("MISSING") || cleaned.includes("NOT_FOUND")) {
    return "MISSING_RECORD";
  }
  if (cleaned.includes("HUMAN") || cleaned.includes("REVIEW") || cleaned.includes("MANUAL") || cleaned.includes("ESCALAT")) {
    return "REQUIRES_HUMAN_REVIEW";
  }
  if (cleaned.includes("UNEXPLAIN") || cleaned.includes("UNKNOWN") || cleaned.includes("UNRESOLVED") || cleaned.includes("DISCREPANCY")) {
    return "UNEXPLAINED";
  }
  if (cleaned === "MATCH" || cleaned.includes("MATCHED")) {
    return "MATCHED";
  }

  return "REQUIRES_HUMAN_REVIEW";
}

const ExceptionJudgmentSchema = z.object({
  classification: JudgmentClassificationEnum,
  confidence: z.number().min(0).max(100),
  explanation: z.string(),
  evidence_ids: z
    .array(z.string())
    .describe("source_refs of evidence items cited — must only reference items returned by search_evidence or get_amazon_deduction_context during this run"),
  recommended_action: z.string(),
  merchant_category: z.enum([
    "referral fee",
    "closing fee",
    "fulfillment fee",
    "weight or handling fee",
    "shipping fee",
    "storage fee",
    "return processing charge",
    "promotional rebate",
    "statutory tax withholding",
    "reserve or balance movement",
    "marketplace tax or fee",
    "other marketplace deduction",
    "unresolved",
  ]).optional(),
});

export type ExceptionJudgment = z.infer<typeof ExceptionJudgmentSchema>;

export interface InvestigateResult {
  exception_id: string;
  judgment_id: string;
  classification: JudgmentClassification;
  confidence: number;
  explanation: string;
  evidence_ids: string[];
  recommended_action: string;
  merchant_category?: string;
  trace: AgentTraceStep[];
  hitStepBudget: boolean;
  model: string;
}

const CLASSIFICATIONS_REQUIRING_EVIDENCE = new Set([
  "MATCHED_WITH_ADJUSTMENT",
  "REFUND",
  "FEE",
  "DUPLICATE",
]);

/**
 * Investigates a reconciliation exception using the agentic loop.
 * The model decides what to look at turn by turn; this function just sets up
 * the context and enforces the hallucination guard on the way out.
 */
export async function runExceptionInvestigation(params: {
  exceptionId: string;
  merchantId: string;
}): Promise<InvestigateResult> {
  const { exceptionId, merchantId } = params;
  const supabase = getServiceSupabase();

  // Fetch exception for system prompt context
  const { data: exception, error: exErr } = await supabase
    .schema("finance")
    .from("exceptions")
    .select("*")
    .eq("id", exceptionId)
    .single();

  if (exErr || !exception) {
    throw new Error(`Exception not found: ${exErr?.message}`);
  }

  const llm = getLLMProvider("judge");

  const systemPrompt = `You are the Mercora Finance Investigation Agent — an autonomous reconciliation analyst.

Your task is to investigate a financial reconciliation exception and classify it with supporting evidence.

AVAILABLE TOOLS:
- get_exception_details: Fetch the exception row and linked transaction events. Call this first.
- get_transaction_chain: Trace the full SALE→PAYMENT→SETTLEMENT→BANK chain for an order.
- get_bank_credit: Fetch a bank credit's exact narration, amount, and date.
- list_candidate_batches: List only currently-unmatched Razorpay/courier batches in a requested range.
- get_narration_history: Retrieve confirmed narration precedents for a source.
- get_amazon_deduction_context: Retrieve the verified Amazon line item, sibling deductions, original order, and Shopify return events.
- search_evidence: Search support tickets and refund records with filters you choose.
- request_human_review: Escalate when evidence is genuinely insufficient after investigation.

INVESTIGATION PROTOCOL:
1. Always start with get_exception_details to understand the discrepancy.
2. Use get_transaction_chain to verify the payment chain if order refs are available.
3. For an Amazon exception, call get_amazon_deduction_context and reason over its exact code, signed amount, comparable settlement lines, and full-lookback return context.
4. Use search_evidence with specific filters based on what you've learned — not blindly.
5. If evidence clearly explains the discrepancy, proceed to a confident classification.
6. If evidence is genuinely absent or ambiguous after searching, call request_human_review.

ALLOWED CLASSIFICATIONS:
- MATCHED: Discrepancy fully explained by natural rounding or data alignment.
- MATCHED_WITH_ADJUSTMENT: Discrepancy explained by verified manual adjustment/goodwill discount with attached evidence.
- TIMING_DIFFERENCE: Settlement vs bank payout date delay.
- FEE: Gateway processing or bank charge explanation.
- REFUND: Verified customer refund or return record.
- DUPLICATE: Repeated transaction row.
- MISSING_RECORD: Missing settlement or bank leg without evidence.
- UNEXPLAINED: No valid evidence found explaining the variance.
- REQUIRES_HUMAN_REVIEW: Ambiguous, conflicting, or insufficient evidence.

CRITICAL RULES — THESE ARE NON-NEGOTIABLE:
- You must NEVER state a cause you did not verify via a tool call.
- For Amazon, never silently rename an unfamiliar amount-description. If the retrieved context does not support a confident merchant-facing category, classify it as REQUIRES_HUMAN_REVIEW and say which code remains unresolved.
- evidence_ids in your final answer must ONLY be source_refs returned by search_evidence or evidence_refs returned by get_amazon_deduction_context during THIS investigation.
- If no tool call returned evidence explaining the variance, classify as UNEXPLAINED or call request_human_review.
- For an unfamiliar Amazon code, include merchant_category only when the retrieved Amazon context supports one of these labels: referral fee, closing fee, fulfillment fee, weight or handling fee, shipping fee, storage fee, return processing charge, promotional rebate, reserve or balance movement, marketplace tax or fee, other marketplace deduction, or unresolved.
- Do not fabricate order references, amounts, dates, or evidence items.
- Confidence scores must reflect actual evidence quality — not optimism.`;

  const initialUserMessage = `Investigate this exception:
- Exception ID: ${exception.id}
- Type: ${exception.exception_type}
- Expected Amount: ₹${Number(exception.expected_amount).toFixed(2)}
- Actual Amount: ₹${Number(exception.actual_amount).toFixed(2)}
- Discrepancy: ₹${Number(exception.difference).toFixed(2)}

Use your tools to investigate. Call get_exception_details first to see the full context, then decide what to look at next.`;

  const finalResponseSchema = zodToJsonSchema(ExceptionJudgmentSchema as any, "ExceptionJudgment");

  // Run the agent loop
  const loopResult = await runAgentLoop<ExceptionJudgment>({
    systemPrompt,
    initialUserMessage,
    tools: financeToolDefinitions,
    toolImplementations: createFinanceToolImplementations({ merchantId, missionId: exception.mission_id }),
    maxSteps: 6,
    finalResponseSchema,
    llmProvider: llm,
    auditContext: {
      merchantId,
      missionId: exception.mission_id,
      entityType: "finance.exceptions",
      entityId: exceptionId,
    },
  });

  // ── Normalize LLM output ───────────────────────────────────────────────────
  const raw = (loopResult.finalAnswer || {}) as Record<string, any>;
  const rawConfidence = Number(raw.confidence ?? raw.confidence_score ?? raw.confidence_pct ?? 0);
  const normalized = {
    classification: normalizeClassification(raw.classification),
    confidence: isNaN(rawConfidence) ? 75 : Math.min(100, Math.max(0, rawConfidence)),
    explanation: String(raw.explanation ?? raw.summary ?? raw.reasoning ?? "Investigation completed."),
    evidence_ids: Array.isArray(raw.evidence_ids)
      ? raw.evidence_ids.map((id: any) => String(id).trim()).filter(Boolean)
      : Array.isArray(raw.cited_evidence_ids)
      ? raw.cited_evidence_ids.map((id: any) => String(id).trim()).filter(Boolean)
      : Array.isArray(raw.evidenceIds)
      ? raw.evidenceIds.map((id: any) => String(id).trim()).filter(Boolean)
      : [],
    recommended_action: String(
      raw.recommended_action ?? raw.recommendedAction ?? raw.action ?? raw.recommendation ?? "Review manually in financial portal."
    ),
    merchant_category: typeof raw.merchant_category === "string" ? raw.merchant_category.trim().toLowerCase() : undefined,
  };

  let judgment: ExceptionJudgment;
  try {
    judgment = ExceptionJudgmentSchema.parse(normalized);
  } catch (parseErr: any) {
    throw new Error(`Invalid judgment shape from agent loop: ${parseErr.message}`);
  }

  // ── Hallucination guard (Batch 5 — stricter): validate against this run's trace ──
  const { validRefs, droppedRefs } = validateEvidenceAgainstTrace({
    citedSourceRefs: judgment.evidence_ids,
    trace: loopResult.trace,
  });

  if (droppedRefs.length > 0) {
    console.warn(
      `[HallucinationGuard] Exception ${exceptionId}: dropped ${droppedRefs.length} evidence ref(s) not seen in trace.`
    );
  }

  // ── DB constraint safeguard ────────────────────────────────────────────────
  let finalClassification = judgment.classification;
  let finalExplanation = judgment.explanation;

  if (CLASSIFICATIONS_REQUIRING_EVIDENCE.has(finalClassification) && validRefs.length === 0) {
    console.warn(
      `[Judge Safeguard] Classification ${finalClassification} requires evidence but none validated. Downgrading.`
    );
    finalClassification = "REQUIRES_HUMAN_REVIEW";
    finalExplanation = `[Downgraded from ${judgment.classification} — no verified evidence in trace]: ${judgment.explanation}`;
  }

  // ── Delete stale evidence, insert freshly found evidence ──────────────────
  await supabase.schema("finance").from("evidence").delete().eq("exception_id", exceptionId);

  let insertedEvidenceIds: string[] = [];

  if (validRefs.length > 0) {
    // Reconstruct evidence rows only from tool results seen in this run.
    const retrievedEvidence: any[] = [];
    for (const step of loopResult.trace) {
      if (step.toolName === "get_amazon_deduction_context") {
        const result = step.result as any;
        const amazonLine = result?.amazon_line;
        const siblings = Array.isArray(result?.settlement_siblings) ? result.settlement_siblings : [];
        for (const item of [amazonLine, ...siblings]) {
          if (!item) continue;
          for (const ref of [item.id, item.external_ref]) {
            if (ref) retrievedEvidence.push({ source_type: "amazon_settlement", source_ref: String(ref), content: `Verified Amazon settlement context: ${JSON.stringify(item)}`, relevance_score: 100 });
          }
        }
        continue;
      }
      if (step.toolName !== "search_evidence") continue;
      const result = step.result as any;
      if (result?.results) retrievedEvidence.push(...result.results);
    }

    const evidenceRows = validRefs
      .map((ref) => {
        const item = retrievedEvidence.find((r: any) => r.source_ref === ref);
        if (!item) return null;
        return {
          exception_id: exceptionId,
          source_type: item.source_type,
          content: item.content,
          source_ref: item.source_ref,
          relevance_score: item.relevance_score,
          found_by: "gemini_retrieval",
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (evidenceRows.length > 0) {
      const { data: insertedRows, error: evInsertErr } = await supabase
        .schema("finance")
        .from("evidence")
        .insert(evidenceRows)
        .select("id, source_ref");

      if (evInsertErr) {
        throw new Error(`Failed to save evidence: ${evInsertErr.message}`);
      }

      insertedEvidenceIds = (insertedRows || []).map((r: any) => r.id);
    }
  }

  // ── Update exception status ────────────────────────────────────────────────
  const newStatus =
    finalClassification !== "UNEXPLAINED" && finalClassification !== "REQUIRES_HUMAN_REVIEW"
      ? "explained"
      : "requires_human_review";

  await supabase.schema("finance").from("exceptions").update({ status: newStatus }).eq("id", exceptionId);

  // Persist an agent-resolved merchant category on the exact Amazon line(s)
  // without letting that label affect any financial arithmetic. The category
  // is accepted only through the constrained structured response above.
  if (
    normalized.merchant_category &&
    normalized.merchant_category !== "unresolved" &&
    ["amazon_unknown_deduction", "amazon_return_clawback", "amazon_fee_anomaly"].includes(exception.exception_type)
  ) {
    const { data: linkedAmazonEvents } = await supabase
      .schema("finance")
      .from("normalized_events")
      .select("id, metadata")
      .in("id", exception.normalized_event_ids || [])
      .eq("source_system", "amazon");
    for (const amazonEvent of linkedAmazonEvents || []) {
      await supabase
        .schema("finance")
        .from("normalized_events")
        .update({
          metadata: {
            ...(amazonEvent.metadata || {}),
            deduction_label: normalized.merchant_category,
            deduction_category: "agent_classified",
            classification_method: "agent_context",
            classification_confidence: normalized.confidence,
            classification_reason: normalized.explanation,
          },
        })
        .eq("id", amazonEvent.id);
    }
  }

  // ── Insert judgment row ────────────────────────────────────────────────────
  const { data: judgmentRow, error: jErr } = await supabase
    .schema("finance")
    .from("exception_judgments")
    .insert({
      exception_id: exceptionId,
      classification: finalClassification,
      confidence: judgment.confidence,
      explanation: finalExplanation,
      evidence_ids: insertedEvidenceIds,
      recommended_action: judgment.recommended_action,
    })
    .select("*")
    .single();

  if (jErr || !judgmentRow) {
    throw new Error(`Failed to record exception judgment: ${jErr?.message}`);
  }

  // ── Write final audit entry ────────────────────────────────────────────────
  await writeAuditLog({
    merchant_id: merchantId,
    mission_id: exception.mission_id,
    actor_type: "gemini",
    actor_id: llm.name,
    action: "exception.judged",
    entity_type: "finance.exception_judgments",
    entity_id: judgmentRow.id,
    after: {
      classification: finalClassification,
      confidence: judgment.confidence,
      evidence_ids_count: insertedEvidenceIds.length,
      trace_steps: loopResult.trace.length,
      hit_step_budget: loopResult.hitStepBudget,
    },
  });

  return {
    exception_id: exceptionId,
    judgment_id: judgmentRow.id,
    classification: finalClassification,
    confidence: judgment.confidence,
    explanation: finalExplanation,
    evidence_ids: insertedEvidenceIds,
    recommended_action: judgment.recommended_action,
    merchant_category: judgment.merchant_category,
    trace: loopResult.trace,
    hitStepBudget: loopResult.hitStepBudget,
    model: llm.name,
  };
}
