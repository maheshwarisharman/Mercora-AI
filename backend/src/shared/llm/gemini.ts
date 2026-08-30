import type {
  LLMProvider,
  StructuredCompletionRequest,
  StructuredCompletionResult,
  AgentStepRequest,
  AgentStepResult,
  AgentMessage,
} from "./types";

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

/**
 * Maps a JSON Schema type string to Gemini's uppercase type format.
 * Gemini function parameters use "STRING", "NUMBER", "BOOLEAN", "OBJECT", "ARRAY".
 */
function sanitizeToolParameterSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeToolParameterSchema);

  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "$ref" || key === "definitions" || key === "$defs" || key === "additionalProperties") {
      continue;
    }
    if (key === "type" && typeof value === "string") {
      clean[key] = value.toUpperCase();
    } else if (value && typeof value === "object") {
      clean[key] = sanitizeToolParameterSchema(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export class GeminiProvider implements LLMProvider {
  public readonly name = "gemini";
  private readonly purpose: "investigate" | "judge" | "summary";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(purpose: "investigate" | "judge" | "summary") {
    this.purpose = purpose;
    this.apiKey = process.env.GEMINI_API_KEY || "";

    if (purpose === "judge" && process.env.GEMINI_JUDGE_MODEL) {
      this.model = process.env.GEMINI_JUDGE_MODEL;
    } else {
      this.model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Single-shot Structured Completion (unchanged from Batch 4)
  // ──────────────────────────────────────────────────────────────────────────

  public async generateStructured<T>(
    req: StructuredCompletionRequest
  ): Promise<StructuredCompletionResult<T>> {
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Gemini API request failed [${response.status} ${response.statusText}]: ${errorText}`
        );
      }

      const json = (await response.json()) as any;

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

    // ── Offline mock for generateStructured ────────────────────────────────
    const mockData = this._mockStructuredResponse<T>(req);
    return {
      data: mockData,
      rawResponse: { simulated: true, output: mockData },
      model: this.model,
      provider: this.name,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Agent Step — Gemini function calling
  // NOTE: Gemini does not allow combining `tools` with `responseSchema` in the
  // same request (they are mutually exclusive). The agent loop therefore uses
  // this method only for investigation steps (no responseSchema), and calls
  // generateStructured separately for the final committing call.
  // ──────────────────────────────────────────────────────────────────────────

  public async runAgentStep(req: AgentStepRequest): Promise<AgentStepResult> {
    if (this.apiKey && this.apiKey.trim() !== "" && this.apiKey !== "mock") {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

      // Convert AgentMessage[] → Gemini contents[]
      const contents = this._agentMessagesToGeminiContents(req.messages);

      // Convert ToolDefinition[] → Gemini function_declarations
      const functionDeclarations = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: sanitizeToolParameterSchema(t.parameters),
      }));

      const payload: Record<string, any> = {
        contents,
        tools: [{ function_declarations: functionDeclarations }],
        // No responseSchema — tools and responseSchema are mutually exclusive on Gemini
        generationConfig: {
          temperature: 0.1,
        },
      };

      if (req.systemPrompt) {
        payload.systemInstruction = { parts: [{ text: req.systemPrompt }] };
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Gemini agent step failed [${response.status} ${response.statusText}]: ${errorText}`
        );
      }

      const json = (await response.json()) as any;
      const candidate = json.candidates?.[0];
      const parts: any[] = candidate?.content?.parts || [];

      // Check for function call parts
      const functionCallParts = parts.filter((p: any) => p.functionCall);
      if (functionCallParts.length > 0) {
        const toolCalls = functionCallParts.map((p: any, i: number) => ({
          id: `call_${Date.now()}_${i}`,
          name: p.functionCall.name as string,
          arguments: (p.functionCall.args || {}) as Record<string, unknown>,
        }));
        const message: AgentMessage = {
          role: "assistant",
          content: "",
          toolCalls,
          rawParts: parts,
        };
        return { message, requestsToolCalls: true };
      }

      // Plain text response — agent is done investigating
      const textParts = parts.filter((p: any) => typeof p.text === "string" && p.text.trim());
      const content = textParts.map((p: any) => p.text).join("\n").trim();

      const message: AgentMessage = { role: "assistant", content, rawParts: parts };
      return { message, requestsToolCalls: false };
    }

    // ── Offline mock for runAgentStep ──────────────────────────────────────
    return this._mockAgentStep(req);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  private _agentMessagesToGeminiContents(messages: AgentMessage[]): any[] {
    const contents: any[] = [];
    for (const msg of messages) {
      if (msg.role === "system") continue; // handled via systemInstruction
      if (msg.role === "user") {
        contents.push({ role: "user", parts: [{ text: msg.content }] });
      } else if (msg.role === "assistant") {
        if (msg.rawParts && Array.isArray(msg.rawParts) && msg.rawParts.length > 0) {
          // Preserve exact parts from Gemini (crucial for thought_signatures in 2.5/3.x)
          contents.push({
            role: "model",
            parts: msg.rawParts,
          });
        } else if (msg.toolCalls && msg.toolCalls.length > 0) {
          // Fallback if rawParts wasn't saved (e.g. offline mock or other source)
          contents.push({
            role: "model",
            parts: msg.toolCalls.map((tc) => ({
              functionCall: { name: tc.name, args: tc.arguments },
            })),
          });
        } else {
          contents.push({ role: "model", parts: [{ text: msg.content }] });
        }
      } else if (msg.role === "tool") {
        // Function response — must follow the functionCall part
        let result: unknown;
        try {
          result = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        } catch {
          result = msg.content;
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.toolCallId || "tool",
                response: { result },
              },
            },
          ],
        });
      }
    }
    return contents;
  }

  /** Stateful mock: simulates a 3-step trace then returns a final text summary */
  private _mockStepIndex = 0;

  private _mockAgentStep(req: AgentStepRequest): AgentStepResult {
    // Keep the offline/demo provider useful for the same cross-source QA path
    // as the live model. This branch is intentionally based on the user's
    // question and the returned tool result, rather than fabricated figures.
    const latestQuestion = [...req.messages]
      .reverse()
      .find((message) => message.role === "user")?.content.toLowerCase() || "";
    const isSourceComparison =
      latestQuestion.includes("amazon") &&
      latestQuestion.includes("shopify") &&
      /(sale|sell|revenue|amount|versus|vs)/.test(latestQuestion);
    const hasSourceComparisonResult = req.messages.some(
      (message) => message.role === "tool" && message.content.includes("sales_comparison")
    );

    if (isSourceComparison) {
      if (!hasSourceComparisonResult) {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "mock_source_comparison", name: "compare_sales_by_source", arguments: {} }],
          },
          requestsToolCalls: true,
        };
      }
      return {
        message: { role: "assistant", content: "Source comparison retrieved." },
        requestsToolCalls: false,
      };
    }

    const stepSeq = [
      // Step 0: call get_exception_details
      (): AgentStepResult => ({
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "mock_call_0",
              name: "get_exception_details",
              arguments: { exception_id: "mock-exception-id" },
            },
          ],
        },
        requestsToolCalls: true,
      }),
      // Step 1: call get_transaction_chain
      (): AgentStepResult => ({
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "mock_call_1",
              name: "get_transaction_chain",
              arguments: { order_ref: "SHF-1038" },
            },
          ],
        },
        requestsToolCalls: true,
      }),
      // Step 2: call search_evidence
      (): AgentStepResult => ({
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "mock_call_2",
              name: "search_evidence",
              arguments: {
                query: "goodwill adjustment packaging damage SHF-1038",
                filters: { amount_min: 490, amount_max: 510 },
              },
            },
          ],
        },
        requestsToolCalls: true,
      }),
      // Step 3: final text — done investigating
      (): AgentStepResult => ({
        message: {
          role: "assistant",
          content:
            "Investigation complete. The ₹500 variance is explained by a goodwill concession documented in TICK-8842 and RF-5502. I have sufficient evidence to classify this exception.",
        },
        requestsToolCalls: false,
      }),
    ];

    const idx = Math.min(this._mockStepIndex, stepSeq.length - 1);
    this._mockStepIndex++;
    return stepSeq[idx]();
  }

  private _mockStructuredResponse<T>(req: StructuredCompletionRequest): T {
    if (this.purpose === "investigate") {
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
      return { selected_evidence_refs, reasoning } as T;
    }

    if (this.purpose === "summary") {
      return {
        healthVerdict: "needs_review",
        headline: "Your reconciliation is complete and the remaining work is concentrated in the open exceptions.",
        insights: [
          {
            text: "Review the outstanding items before closing this mission.",
            metricRef: "exceptions.byStatus.open",
            severity: "warning",
          },
          {
            text: "The matched portion of sales has a clear bank trail.",
            metricRef: "matchHealth.overallMatchRatePct",
            severity: "info",
          },
        ],
        recommendedActions: [
          { text: "Start with the highest value open exceptions and confirm their supporting records." },
        ],
      } as T;
    }

    // Judge purpose
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

    // Q&A purpose — detect from userPrompt shape
    if (req.userPrompt.includes('"answer"') || req.userPrompt.includes("cited_exception_ids")) {
      if (req.userPrompt.includes('"sales_comparison"')) {
        const readMetric = (name: string): number | null => {
          const match = req.userPrompt.match(new RegExp(`"${name}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
          if (!match) return null;
          const value = Number(match[1]);
          return Number.isFinite(value) ? value : null;
        };
        const amazon = readMetric("amazon_gross_sales_inr");
        const shopify = readMetric("shopify_gross_sales_inr");
        const difference = readMetric("amazon_minus_shopify_inr");
        if (amazon !== null && shopify !== null && difference !== null) {
          return {
            answer: `Amazon gross sales were ₹${amazon.toFixed(2)} versus Shopify gross sales of ₹${shopify.toFixed(2)}, a difference of ₹${difference.toFixed(2)} in favor of ${difference >= 0 ? "Amazon" : "Shopify"}.`,
            cited_exception_ids: [],
            cited_evidence_ids: [],
          } as T;
        }
      }
      return {
        answer: "Based on the current mission data, I found several open exceptions that need your attention. The most significant is an unexplained ₹500 difference on order SHF-1038.",
        cited_exception_ids: [],
        cited_evidence_ids: [],
      } as T;
    }

    return { classification, confidence, explanation, evidence_ids, recommended_action } as T;
  }
}
