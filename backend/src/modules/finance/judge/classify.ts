import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getServiceSupabase } from "../../../shared/db/supabase";
import { getLLMProvider } from "../../../shared/llm";
import { writeAuditLog } from "../shared/audit";
import type { NormalizedEvent } from "../shared/types";
import { normalizeClassification } from "../investigate/run";

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

const JudgeOutputSchema = z.object({
  classification: JudgmentClassificationEnum.describe("Standardized classification of this exception judgment"),
  confidence: z.number().min(0).max(100).describe("Confidence percentage in this judgment (0-100)"),
  explanation: z.string().describe("Comprehensive financial explanation citing supporting evidence"),
  evidence_ids: z.array(z.string()).describe("List of exact evidence UUIDs cited from the provided evidence list"),
  recommended_action: z.string().describe("Actionable merchant advice (e.g. 'Accept adjustment', 'Review ticket #', 'File claim')"),
});

export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export interface JudgeResult {
  judgment_id: string;
  exception_id: string;
  classification: JudgmentClassification;
  confidence: number;
  explanation: string;
  evidence_ids: string[];
  recommended_action: string;
  model: string;
}

/**
 * Executes Judge evaluation for an exception and its linked evidence.
 * Enforces strict anti-hallucination validation and database constraint safety.
 */
export async function runExceptionJudgment(params: {
  exceptionId: string;
  merchantId: string;
}): Promise<JudgeResult> {
  const { exceptionId, merchantId } = params;
  const supabase = getServiceSupabase();

  // 1. Fetch Exception Row
  const { data: exception, error: exErr } = await supabase
    .schema("finance")
    .from("exceptions")
    .select("*")
    .eq("id", exceptionId)
    .single();

  if (exErr || !exception) {
    throw new Error(`Exception not found: ${exErr?.message}`);
  }

  // 2. Fetch Attached Evidence
  const { data: evidenceRows, error: evErr } = await supabase
    .schema("finance")
    .from("evidence")
    .select("*")
    .eq("exception_id", exceptionId);

  if (evErr) {
    throw new Error(`Failed to load evidence for exception: ${evErr.message}`);
  }

  const evidenceList = evidenceRows || [];
  const validEvidenceIdMap = new Map<string, any>();
  evidenceList.forEach((ev) => validEvidenceIdMap.set(ev.id, ev));

  // 3. Fetch Linked Normalized Events
  const eventIds = exception.normalized_event_ids || [];
  let linkedEvents: NormalizedEvent[] = [];
  if (eventIds.length > 0) {
    const { data: evts, error: nError } = await supabase
      .schema("finance")
      .from("normalized_events")
      .select("*")
      .in("id", eventIds);

    if (!nError && evts) {
      linkedEvents = evts as NormalizedEvent[];
    }
  }

  // 4. LLM Call via Provider Abstraction
  const llm = getLLMProvider("judge");

  const systemPrompt = `You are the Mercora Finance Judge Agent.
Your role is to classify a reconciliation exception and produce a final, authoritative financial judgment grounded strictly in verified evidence.

Available Classifications:
- MATCHED: Discrepancy fully explained by natural rounding or data alignment.
- MATCHED_WITH_ADJUSTMENT: Discrepancy explained by verified manual adjustment/goodwill discount with attached evidence.
- TIMING_DIFFERENCE: Settlement vs bank payout date delay.
- FEE: Gateway processing or bank charge explanation.
- REFUND: Verified customer refund or return record.
- DUPLICATE: Repeated transaction row.
- MISSING_RECORD: Missing settlement or bank leg without evidence.
- UNEXPLAINED: No valid evidence found explaining the variance.
- REQUIRES_HUMAN_REVIEW: Ambiguous, conflicting, or insufficient evidence.

CRITICAL RULES:
1. Grounding: 'evidence_ids' must ONLY contain IDs from the provided evidence list.
2. Factuality: If no evidence explains the variance, classify as UNEXPLAINED or REQUIRES_HUMAN_REVIEW. Never hallucinate reasons.`;

  const userPrompt = `Reconciliation Exception Details:
- Exception ID: ${exception.id}
- Exception Type: ${exception.exception_type}
- Expected Amount: ₹${Number(exception.expected_amount).toFixed(2)}
- Actual Amount: ₹${Number(exception.actual_amount).toFixed(2)}
- Variance / Difference: ₹${Number(exception.difference).toFixed(2)}

Linked Transaction Events:
${linkedEvents
  .map(
    (e) =>
      `• [${e.event_type}] Source: ${e.source_system}, Ref: ${e.external_ref || "N/A"}, Amount: ₹${Number(e.amount).toFixed(2)}, Date: ${e.event_date}`
  )
  .join("\n")}

Available Evidence Items:
${
  evidenceList.length === 0
    ? "(No evidence records found for this exception)"
    : evidenceList
        .map(
          (ev) =>
            `[ID: ${ev.id}] Source: ${ev.source_type} (Ref: ${ev.source_ref}) | Relevance: ${ev.relevance_score}%\nContent: "${ev.content}"`
        )
        .join("\n\n")
}

Evaluate and return the structured JSON judgment.`;

  const responseJsonSchema = zodToJsonSchema(JudgeOutputSchema as any, "JudgeOutput");

  const completion = await llm.generateStructured<JudgeOutput>({
    systemPrompt,
    userPrompt,
    responseSchema: responseJsonSchema,
    temperature: 0.1,
  });

  // Normalize LLM output: models sometimes return variant field names
  // (e.g. "confidence_score" instead of "confidence") despite the schema hint.
  const raw = completion.data as Record<string, any>;
  const rawConfidence = Number(raw?.confidence ?? raw?.confidence_score ?? raw?.confidence_pct ?? 0);
  const normalized = {
    classification: normalizeClassification(raw?.classification),
    confidence: isNaN(rawConfidence) ? 75 : Math.min(100, Math.max(0, rawConfidence)),
    explanation: String(raw?.explanation ?? raw?.summary ?? raw?.reasoning ?? "Judgment completed."),
    evidence_ids: Array.isArray(raw?.evidence_ids)
      ? raw.evidence_ids.map((id: any) => String(id).trim()).filter(Boolean)
      : Array.isArray(raw?.cited_evidence_ids)
      ? raw.cited_evidence_ids.map((id: any) => String(id).trim()).filter(Boolean)
      : Array.isArray(raw?.evidenceIds)
      ? raw.evidenceIds.map((id: any) => String(id).trim()).filter(Boolean)
      : [],
    recommended_action: String(
      raw?.recommended_action ?? raw?.recommendedAction ?? raw?.action ?? raw?.recommendation ?? "Review manually in financial portal."
    ),
  };

  const validatedOutput = JudgeOutputSchema.parse(normalized);

  // 5. Anti-Hallucination Guardrail: validate cited evidence_ids against real DB records
  const validCitedEvidenceIds: string[] = [];
  for (const id of validatedOutput.evidence_ids) {
    if (validEvidenceIdMap.has(id)) {
      validCitedEvidenceIds.push(id);
    } else {
      console.warn(`[Anti-Hallucination Judge] Dropping non-existent evidence id: ${id}`);
    }
  }

  let finalClassification = validatedOutput.classification;
  let finalExplanation = validatedOutput.explanation;

  // 6. DB CHECK Constraint Safeguard:
  // Classifications ('MATCHED_WITH_ADJUSTMENT', 'REFUND', 'FEE', 'DUPLICATE') MUST have array_length(evidence_ids, 1) >= 1
  const requiresEvidenceClassifications = new Set([
    "MATCHED_WITH_ADJUSTMENT",
    "REFUND",
    "FEE",
    "DUPLICATE",
  ]);

  if (requiresEvidenceClassifications.has(finalClassification) && validCitedEvidenceIds.length === 0) {
    console.warn(
      `[Judge Safeguard] Classification ${finalClassification} requires evidence but none was validly cited. Downgrading to REQUIRES_HUMAN_REVIEW.`
    );
    finalClassification = "REQUIRES_HUMAN_REVIEW";
    finalExplanation = `[Downgraded from ${validatedOutput.classification} due to insufficient verified evidence]: ${validatedOutput.explanation}`;
  }

  // 7. Insert Append-Only Judgment Row into finance.exception_judgments
  const { data: judgmentRow, error: jErr } = await supabase
    .schema("finance")
    .from("exception_judgments")
    .insert({
      exception_id: exceptionId,
      classification: finalClassification,
      confidence: validatedOutput.confidence,
      explanation: finalExplanation,
      evidence_ids: validCitedEvidenceIds,
      recommended_action: validatedOutput.recommended_action,
    })
    .select("*")
    .single();

  if (jErr || !judgmentRow) {
    console.error("Error inserting exception judgment:", jErr);
    throw new Error(`Failed to record exception judgment: ${jErr?.message}`);
  }

  // 8. Update Exception Status
  const newExStatus =
    finalClassification !== "UNEXPLAINED" && finalClassification !== "REQUIRES_HUMAN_REVIEW"
      ? "explained"
      : "requires_human_review";

  await supabase
    .schema("finance")
    .from("exceptions")
    .update({ status: newExStatus })
    .eq("id", exceptionId);

  // 9. Write Audit Log
  await writeAuditLog({
    merchant_id: merchantId,
    mission_id: exception.mission_id,
    actor_type: "gemini",
    actor_id: completion.model,
    action: "exception.judged",
    entity_type: "finance.exception_judgments",
    entity_id: judgmentRow.id,
    after: {
      classification: finalClassification,
      confidence: validatedOutput.confidence,
      evidence_ids_count: validCitedEvidenceIds.length,
      explanation: finalExplanation,
      recommended_action: validatedOutput.recommended_action,
    },
  });

  return {
    judgment_id: judgmentRow.id,
    exception_id: exceptionId,
    classification: finalClassification,
    confidence: Number(validatedOutput.confidence),
    explanation: finalExplanation,
    evidence_ids: validCitedEvidenceIds,
    recommended_action: validatedOutput.recommended_action,
    model: completion.model,
  };
}
