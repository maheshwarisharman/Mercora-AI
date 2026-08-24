import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getServiceSupabase } from "../../../shared/db/supabase";
import { getLLMProvider } from "../../../shared/llm";
import { writeAuditLog } from "../shared/audit";
import { retrieveCandidateEvidence, type CandidateEvidence } from "./retrieval";
import type { NormalizedEvent } from "../shared/types";

const InvestigateOutputSchema = z.object({
  selected_evidence_refs: z.array(z.string()).describe("List of exact source_refs from provided candidates that explain this variance"),
  reasoning: z.string().describe("Detailed factual explanation of why the selected evidence items account for the variance"),
});

export type InvestigateOutput = z.infer<typeof InvestigateOutputSchema>;

export interface InvestigateResult {
  exception_id: string;
  selected_candidates: CandidateEvidence[];
  evidence_rows_created: number;
  reasoning: string;
  model: string;
}

/**
 * Investigates an exception by retrieving candidate evidence and prompting the LLM
 * provider to select ground-truth explanations without hallucination.
 */
export async function runExceptionInvestigation(params: {
  exceptionId: string;
  merchantId: string;
}): Promise<InvestigateResult> {
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

  // 2. Fetch Linked Normalized Events
  const eventIds = exception.normalized_event_ids || [];
  let linkedEvents: NormalizedEvent[] = [];
  if (eventIds.length > 0) {
    const { data: evts, error: evErr } = await supabase
      .schema("finance")
      .from("normalized_events")
      .select("*")
      .in("id", eventIds);

    if (!evErr && evts) {
      linkedEvents = evts as NormalizedEvent[];
    }
  }

  // 3. Deterministic Evidence Retrieval
  const difference = Math.abs(Number(exception.difference) || 0);
  const candidates = retrieveCandidateEvidence({
    difference,
    linkedEvents,
  });

  const candidateRefMap = new Map<string, CandidateEvidence>();
  candidates.forEach((c) => candidateRefMap.set(c.source_ref, c));

  // 4. LLM Call via Provider Abstraction
  const llm = getLLMProvider("investigate");

  const systemPrompt = `You are the Mercora Finance Investigation Agent.
Your role is to analyze a financial reconciliation exception and determine which, if any, of the candidate business documents (support tickets, refund records) explain the discrepancy.
CRITICAL RULES:
1. Grounding: You must ONLY select evidence items from the provided candidate list. Never invent or hallucinate citations or source references.
2. Factuality: If none of the candidates explain the discrepancy, return an empty array for selected_evidence_refs.
3. No Arithmetic fabrication: Do not invent numbers, adjustments, or events not present in the candidates.`;

  const userPrompt = `Reconciliation Exception Context:
- Exception ID: ${exception.id}
- Exception Type: ${exception.exception_type}
- Expected Amount: ₹${Number(exception.expected_amount).toFixed(2)}
- Actual Amount: ₹${Number(exception.actual_amount).toFixed(2)}
- Variance / Difference: ₹${Number(exception.difference).toFixed(2)}

Linked Transaction Events in Chain:
${linkedEvents
  .map(
    (e) =>
      `• [${e.event_type}] Source: ${e.source_system}, Ref: ${e.external_ref || "N/A"}, Amount: ₹${Number(e.amount).toFixed(2)}, Date: ${e.event_date}, Counterparty: ${e.counterparty || "N/A"}`
  )
  .join("\n")}

Candidate Evidence Shortlist:
${
  candidates.length === 0
    ? "(No candidates found)"
    : candidates
        .map(
          (c) =>
            `[${c.source_ref}] Type: ${c.source_type} | Date: ${c.date} | Amount: ${c.amount ? `₹${c.amount}` : "N/A"} | Subject: ${c.title}\nContent: "${c.content}"`
        )
        .join("\n\n")
}

Evaluate the candidates. Return JSON matching the schema with selected_evidence_refs and reasoning.`;

  const responseJsonSchema = zodToJsonSchema(InvestigateOutputSchema as any, "InvestigateOutput");

  const completion = await llm.generateStructured<InvestigateOutput>({
    systemPrompt,
    userPrompt,
    responseSchema: responseJsonSchema,
    temperature: 0.1,
  });

  // Validate output shape with Zod runtime validator
  const validatedOutput = InvestigateOutputSchema.parse(completion.data);

  // 5. Anti-Hallucination Guardrail: strictly filter to provided candidates
  const validSelectedCandidates: CandidateEvidence[] = [];
  for (const ref of validatedOutput.selected_evidence_refs) {
    const candidate = candidateRefMap.get(ref);
    if (candidate) {
      validSelectedCandidates.push(candidate);
    } else {
      console.warn(`[Anti-Hallucination] Dropping non-candidate evidence ref: ${ref}`);
    }
  }

  // 6. Delete old evidence for this exception and insert newly verified evidence
  await supabase
    .schema("finance")
    .from("evidence")
    .delete()
    .eq("exception_id", exceptionId);

  if (validSelectedCandidates.length > 0) {
    const evidenceRows = validSelectedCandidates.map((c) => ({
      exception_id: exceptionId,
      source_type: c.source_type,
      content: c.content,
      source_ref: c.source_ref,
      relevance_score: c.relevance_score,
      found_by: "gemini_retrieval",
    }));

    const { error: evInsertErr } = await supabase
      .schema("finance")
      .from("evidence")
      .insert(evidenceRows);

    if (evInsertErr) {
      console.error("Error inserting evidence:", evInsertErr);
      throw new Error(`Failed to save evidence: ${evInsertErr.message}`);
    }
  }

  // 7. Update Exception Status
  await supabase
    .schema("finance")
    .from("exceptions")
    .update({ status: "investigating" })
    .eq("id", exceptionId);

  // 8. Write Audit Log Entry
  await writeAuditLog({
    merchant_id: merchantId,
    mission_id: exception.mission_id,
    actor_type: "gemini",
    actor_id: completion.model,
    action: "exception.investigated",
    entity_type: "finance.exceptions",
    entity_id: exceptionId,
    after: {
      selected_evidence_count: validSelectedCandidates.length,
      selected_refs: validSelectedCandidates.map((c) => c.source_ref),
      reasoning: validatedOutput.reasoning,
    },
  });

  return {
    exception_id: exceptionId,
    selected_candidates: validSelectedCandidates,
    evidence_rows_created: validSelectedCandidates.length,
    reasoning: validatedOutput.reasoning,
    model: completion.model,
  };
}
