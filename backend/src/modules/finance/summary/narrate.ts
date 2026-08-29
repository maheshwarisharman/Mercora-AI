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
  })).max(6),
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
Narrative prose fields must contain no numerals, currency symbols, percentages,
or IDs. The frontend renders numeric values independently from the aggregate.
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
      return validateMetricRefs(MissionNarrativeSchema.parse(result.data), aggregate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Mission narrative validation failed: ${lastError instanceof Error ? lastError.message : "invalid provider output"}`);
}
