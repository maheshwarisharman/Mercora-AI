import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getLLMProvider } from "../../../shared/llm";
import type { MissionAggregate } from "./aggregate";

const noNumerals = z.string().refine(
  (value) => !/[\d₹$€£%]/u.test(value),
  "Narrative prose may not contain numeric or currency figures; render metrics from the aggregate in the UI."
);

const MissionNarrativeSchema = z.object({
  healthVerdict: z.enum(["healthy", "needs_review", "critical"]),
  headline: noNumerals,
  insights: z.array(z.object({
    text: noNumerals,
    metricRef: z.string().min(1),
    severity: z.enum(["info", "warning", "critical"]),
  })).min(1).max(6),
  recommendedActions: z.array(z.object({
    text: noNumerals,
    relatedExceptionIds: z.array(z.string()).optional(),
  })).max(5),
});

export type MissionNarrative = z.infer<typeof MissionNarrativeSchema>;

const PROMPT_VERSION = "1.0.0";
export { PROMPT_VERSION };

function getPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, root);
}

/**
 * Providers sometimes serialize the same contract using snake_case or a
 * human-friendly verdict such as "needs review". Normalize those transport
 * variations before the strict schema guard runs; never relax the guard itself.
 */
function normalizeHealthVerdict(value: unknown, aggregate: MissionAggregate): "healthy" | "needs_review" | "critical" {
  const rawValue = value && typeof value === "object"
    ? (value as Record<string, unknown>).value ?? (value as Record<string, unknown>).label ?? (value as Record<string, unknown>).status
    : value;
  const verdict = String(rawValue ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (verdict.includes("critical") || verdict.includes("severe") || verdict.includes("urgent")) return "critical";
  if (verdict.includes("healthy") || verdict.includes("good") || verdict.includes("clear")) return "healthy";
  if (verdict.includes("review") || verdict.includes("attention") || verdict.includes("warning") || verdict.includes("risk")) return "needs_review";

  // If a provider returns an unrecognized label, keep the report usable with a
  // conservative deterministic verdict. No financial value is inferred here.
  const hasOpenWork = aggregate.exceptions.byStatus.open > 0 || aggregate.exceptions.byStatus.requiresHumanReview > 0;
  const hasVariance = Math.abs(aggregate.totals.variance) > 0.01;
  return hasOpenWork || hasVariance ? "needs_review" : "healthy";
}

function firstString(record: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return undefined;
}

function asArray(value: unknown, nestedKeys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of nestedKeys) {
      if (Array.isArray(record[key])) return record[key];
    }
  }
  return [];
}

function normalizeNarrativeCandidate(raw: unknown, aggregate: MissionAggregate): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const rawRecord = raw as Record<string, unknown>;
  const candidate = (rawRecord.narrative || rawRecord.data || rawRecord.output || raw) as Record<string, any>;
  const verdict = normalizeHealthVerdict(candidate.healthVerdict ?? candidate.health_verdict ?? candidate.verdict ?? candidate.health, aggregate);
  const rawInsights = candidate.insights ?? candidate.key_insights ?? candidate.keyInsights ?? candidate.observations ?? [];
  const rawActions = candidate.recommendedActions ?? candidate.recommended_actions ?? candidate.next_steps ?? candidate.nextSteps ?? candidate.actions ?? [];

  return {
    ...candidate,
    healthVerdict: verdict,
    headline: candidate.headline ?? candidate.summary_headline ?? candidate.title,
    insights: asArray(rawInsights, ["items", "insights", "observations"]).map((insightValue: unknown) => {
      const insight = typeof insightValue === "string" ? { text: insightValue } : (insightValue || {}) as Record<string, any>;
      const severity = String(insight.severity ?? insight.level ?? insight.priority ?? "info").toLowerCase();
      return {
          ...insight,
          text: firstString(insight, ["text", "insight_text", "observation", "insight", "description", "finding", "summary", "message", "content", "copy"]),
          metricRef: firstString(insight, ["metricRef", "metric_ref", "metricReference", "metric_reference", "metric", "metricPath", "metric_path", "groundedMetric", "sourceField", "referenceField", "field"]),
          severity: severity.includes("critical") ? "critical" : severity.includes("warn") || severity.includes("risk") ? "warning" : "info",
        };
      })
      .filter((insight) => insight.text || insight.metricRef),
    recommendedActions: asArray(rawActions, ["items", "actions", "recommendations"]).map((actionValue: unknown) => {
      const action = typeof actionValue === "string" ? { text: actionValue } : (actionValue || {}) as Record<string, any>;
      return {
          ...action,
          text: firstString(action, ["text", "action_text", "action", "recommendation", "description", "message", "next_action"]),
          relatedExceptionIds: action.relatedExceptionIds ?? action.related_exception_ids,
        };
      }).filter((action) => action.text),
  };
}

function validateMetricRefs(narrative: MissionNarrative, aggregate: MissionAggregate): MissionNarrative {
  for (const insight of narrative.insights) {
    if (typeof getPath(aggregate, insight.metricRef) !== "number") {
      throw new Error(`Narrative metricRef must point to a numeric aggregate field: ${insight.metricRef}`);
    }
  }
  return narrative;
}

const SYSTEM_PROMPT = `You are Mercora's reconciliation report narrator.
You will only receive pre-computed aggregate figures. Do not perform arithmetic.
Do not state a number that is not present in the input JSON. Every insight must
include a metricRef pointing to the exact field in the input you are describing.
Return exactly these camelCase keys: healthVerdict, headline, insights, and
recommendedActions. Each insight must be an object with text, metricRef, and
severity. Each recommended action must be an object with text and may include
relatedExceptionIds. Narrative prose fields must contain no numerals, currency
symbols, percentages, or IDs. The frontend renders numeric values independently
from the aggregate.
Keep the tone concise, calm, and useful to a finance operator. Choose critical
only when the aggregate shows a material unresolved cash gap or many open items.`;

/**
 * Stage 2: a single-shot structured completion. The schema deliberately uses
 * numeral-free prose so a malformed numeric claim is rejected before caching.
 */
export async function generateMissionNarrative(aggregate: MissionAggregate): Promise<MissionNarrative> {
  const provider = getLLMProvider("summary");
  const responseSchema = zodToJsonSchema(MissionNarrativeSchema as any, "MissionNarrative");
  const aggregateJson = JSON.stringify(aggregate);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await provider.generateStructured<MissionNarrative>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `Create the structured mission narrative from this aggregate JSON only:\n${aggregateJson}${attempt ? "\nPrevious output failed validation. Return corrected JSON only." : ""}`,
        responseSchema,
        temperature: 0.1,
      });
      const normalized = normalizeNarrativeCandidate(result.data, aggregate);
      return validateMetricRefs(MissionNarrativeSchema.parse(normalized), aggregate);
    } catch (error) {
      lastError = error;
    }
  }

  // A malformed provider response must not make a deterministic report
  // unusable. This fallback is still numeral-free and every metric reference
  // points into the same aggregate passed to the provider.
  const hasOpenWork = aggregate.exceptions.byStatus.open > 0 || aggregate.exceptions.byStatus.requiresHumanReview > 0;
  const hasMatchedSales = aggregate.matchHealth.overallMatchRatePct > 0;
  return {
    healthVerdict: normalizeHealthVerdict(undefined, aggregate),
    headline: hasOpenWork
      ? "Your reconciliation is complete and a focused review of the remaining exceptions is still needed."
      : "Your reconciliation is complete and the connected records form a clear financial picture.",
    insights: [
      {
        text: hasOpenWork ? "The remaining exceptions are the first place to focus before closing the mission." : "The reconciliation pass has a clean operational outcome.",
        metricRef: "exceptions.byStatus.open",
        severity: hasOpenWork ? "warning" : "info",
      },
      {
        text: hasMatchedSales ? "Some sales are linked to a traceable bank trail." : "No sales are currently linked to a complete bank trail.",
        metricRef: "matchHealth.overallMatchRatePct",
        severity: "info",
      },
    ],
    recommendedActions: hasOpenWork
      ? [{ text: "Start with the highest value open exceptions and confirm their supporting records." }]
      : [],
  };
}
