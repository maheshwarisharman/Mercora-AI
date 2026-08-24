import type { LLMProvider, StructuredCompletionRequest, StructuredCompletionResult } from "./types";

/**
 * Converts a standard JSON Schema (from zod-to-json-schema) into Google Gemini's OpenAPI-compatible schema subset.
 * Strips $schema, $ref, definitions, and additionalProperties.
 */
function sanitizeSchemaForGemini(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  // If top-level contains definitions or $defs, unwrap the root definition
  if (schema.definitions) {
    const rootKey = schema.$ref ? schema.$ref.replace("#/definitions/", "") : Object.keys(schema.definitions)[0];
    if (rootKey && schema.definitions[rootKey]) {
      return sanitizeSchemaForGemini(schema.definitions[rootKey]);
    }
  }

  if (schema.$defs) {
    const rootKey = schema.$ref ? schema.$ref.replace("#/$defs/", "") : Object.keys(schema.$defs)[0];
    if (rootKey && schema.$defs[rootKey]) {
      return sanitizeSchemaForGemini(schema.$defs[rootKey]);
    }
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item));
  }

  const clean: Record<string, any> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "$schema" ||
      key === "$ref" ||
      key === "definitions" ||
      key === "$defs" ||
      key === "additionalProperties"
    ) {
      continue;
    }
    if (value && typeof value === "object") {
      clean[key] = sanitizeSchemaForGemini(value);
    } else if (key === "type" && typeof value === "string") {
      clean[key] = value.toUpperCase();
    } else {
      clean[key] = value;
    }
  }

  return clean;
}

export class GeminiProvider implements LLMProvider {
  public readonly name = "gemini";
  private readonly purpose: "investigate" | "judge";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(purpose: "investigate" | "judge") {
    this.purpose = purpose;
    this.apiKey = process.env.GEMINI_API_KEY || "";

    if (purpose === "judge" && process.env.GEMINI_JUDGE_MODEL) {
      this.model = process.env.GEMINI_JUDGE_MODEL;
    } else {
      this.model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    }
  }

  public async generateStructured<T>(
    req: StructuredCompletionRequest
  ): Promise<StructuredCompletionResult<T>> {
    // If live API key is present, execute standard Gemini structured completion
    if (this.apiKey && this.apiKey.trim() !== "" && this.apiKey !== "mock") {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

      const payload: Record<string, any> = {
        contents: [
          {
            role: "user",
            parts: [{ text: req.userPrompt }],
          },
        ],
        generationConfig: {
          temperature: req.temperature ?? 0.1,
          responseMimeType: "application/json",
        },
      };

      if (req.systemPrompt) {
        payload.systemInstruction = {
          parts: [{ text: req.systemPrompt }],
        };
      }

      if (req.responseSchema) {
        payload.generationConfig.responseSchema = sanitizeSchemaForGemini(req.responseSchema);
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Gemini API request failed [${response.status} ${response.statusText}]: ${errorText}`
        );
      }

      const json = (await response.json()) as any;

      // Thinking models (e.g. gemini-2.5-flash with thinking) return multiple parts:
      // the first part(s) may be internal "thought" tokens; the actual JSON output
      // is always in the LAST text-bearing part.
      const rawParts: any[] = json.candidates?.[0]?.content?.parts || [];
      const candidateText =
        rawParts
          .filter((p: any) => typeof p.text === "string" && p.text.trim() !== "")
          .map((p: any) => p.text)
          .pop() || "";

      if (!candidateText) {
        const finishReason = json.candidates?.[0]?.finishReason;
        throw new Error(
          `Gemini returned an empty response. finishReason=${finishReason}. Full response: ${JSON.stringify(json).slice(0, 500)}`
        );
      }

      let parsedData: T;
      try {
        parsedData = JSON.parse(candidateText) as T;
      } catch (parseError: any) {
        throw new Error(
          `Failed to parse Gemini structured JSON output: ${parseError.message}. Raw text: ${candidateText}`
        );
      }

      return {
        data: parsedData,
        rawResponse: json,
        model: this.model,
        provider: this.name,
      };
    }

    // Local / Offline deterministic fallback simulation when GEMINI_API_KEY is not configured
    if (this.purpose === "investigate") {
      // Analyze user prompt candidates for exact matches
      const hasTick8842 = req.userPrompt.includes("TICK-8842");
      const hasRf5502 = req.userPrompt.includes("RF-5502");

      let selected_evidence_refs: string[] = [];
      let reasoning = "No candidate evidence matched the discrepancy.";

      if (hasTick8842 && (req.userPrompt.includes("500") || req.userPrompt.includes("unexplained_difference"))) {
        selected_evidence_refs.push("TICK-8842");
        if (hasRf5502) selected_evidence_refs.push("RF-5502");
        reasoning =
          "Support Ticket TICK-8842 and Refund Record RF-5502 corroborate a ₹500 manual goodwill concession for package damage on Order #SHF-1038, deducted from merchant settlement.";
      }

      const mockData = {
        selected_evidence_refs,
        reasoning,
      } as T;

      return {
        data: mockData,
        rawResponse: { simulated: true, output: mockData },
        model: this.model,
        provider: this.name,
      };
    } else {
      // Judge Purpose
      const hasEvidence = req.userPrompt.includes("TICK-8842") || req.userPrompt.includes("RF-5502") || req.userPrompt.includes("ID: ");
      const evidenceIdMatches = req.userPrompt.match(/\[ID:\s*([0-9a-fA-F-]+)\]/g);
      const extractedIds = evidenceIdMatches
        ? evidenceIdMatches.map((m) => m.replace(/\[ID:\s*/, "").replace(/\]/, "").trim())
        : [];

      let classification = "UNEXPLAINED";
      let confidence = 85;
      let explanation = "No matching business evidence accounts for this variance.";
      let evidence_ids: string[] = [];
      let recommended_action = "Review manually in financial portal.";

      if (extractedIds.length > 0 && hasEvidence) {
        classification = "MATCHED_WITH_ADJUSTMENT";
        confidence = 94;
        explanation =
          "The ₹500 variance between settlement and bank payout is explained by an authorized customer goodwill adjustment for packaging damage documented in support ticket TICK-8842 and refund record RF-5502.";
        evidence_ids = extractedIds;
        recommended_action = "Accept ₹500 gateway settlement deduction and close exception.";
      } else if (req.userPrompt.includes("missing_settlement") || req.userPrompt.includes("missing_bank_credit")) {
        classification = "MISSING_RECORD";
        confidence = 88;
        explanation = "Transaction recorded in upstream gateway but no corresponding settlement or bank credit was found.";
        recommended_action = "Contact payment gateway support to trace settlement payout batch.";
      } else if (req.userPrompt.includes("timing_difference")) {
        classification = "TIMING_DIFFERENCE";
        confidence = 90;
        explanation = "Bank credit was processed after standard 5-day payout window due to bank holiday processing delay.";
        recommended_action = "Confirm bank credit date and mark resolved.";
      } else if (req.userPrompt.includes("duplicate")) {
        classification = "DUPLICATE";
        confidence = 92;
        explanation = "Duplicate export row detected in Razorpay transactions CSV with identical reference and amount.";
        recommended_action = "Deduplicate transaction record in ledger.";
      }

      const mockData = {
        classification,
        confidence,
        explanation,
        evidence_ids,
        recommended_action,
      } as T;

      return {
        data: mockData,
        rawResponse: { simulated: true, output: mockData },
        model: this.model,
        provider: this.name,
      };
    }
  }
}
