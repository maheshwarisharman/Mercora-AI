import { writeAuditLog } from "../../modules/finance/shared/audit";
import type {
  LLMProvider,
  ToolDefinition,
  AgentMessage,
  AgentTraceStep,
} from "../llm/types";
import { zodToJsonSchema } from "zod-to-json-schema";

/** Hard cap on tool-call steps per agent loop invocation. */
export const MAX_AGENT_STEPS = 6;

export interface RunAgentLoopParams {
  systemPrompt: string;
  initialUserMessage: string;
  /** For multi-turn Q&A: pass prior history. Leave empty for a fresh investigation. */
  conversationHistory?: AgentMessage[];
  tools: ToolDefinition[];
  toolImplementations: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  maxSteps?: number;
  /** JSON Schema (zod-to-json-schema output) that the final committing call must conform to. */
  finalResponseSchema: unknown;
  llmProvider: LLMProvider;
  /** Written to audit_log for each tool call (entity context). */
  auditContext: {
    merchantId: string;
    missionId?: string | null;
    entityType: string;
    entityId?: string | null;
  };
}

export interface AgentLoopResult<T> {
  finalAnswer: T;
  trace: AgentTraceStep[];
  hitStepBudget: boolean;
  /** Full transcript — caller persists for multi-turn Q&A. */
  conversationHistory: AgentMessage[];
}

/**
 * Provider-agnostic agent loop.
 *
 * Mechanics:
 * 1. Call llmProvider.runAgentStep with current message history.
 * 2. If tool calls requested: execute each tool, write audit_log incrementally,
 *    append 'tool' role messages, increment step count, repeat.
 * 3. If plain text returned or maxSteps reached: exit loop.
 * 4. Issue one final generateStructured call (no tools) over accumulated
 *    transcript to force the committed answer shape.
 */
export async function runAgentLoop<T>(params: RunAgentLoopParams): Promise<AgentLoopResult<T>> {
  const {
    systemPrompt,
    initialUserMessage,
    conversationHistory = [],
    tools,
    toolImplementations,
    maxSteps = MAX_AGENT_STEPS,
    finalResponseSchema,
    llmProvider,
    auditContext,
  } = params;

  const trace: AgentTraceStep[] = [];
  let stepCount = 0;
  let hitStepBudget = false;

  // Build initial message history
  const messages: AgentMessage[] = [
    ...conversationHistory,
    { role: "user", content: initialUserMessage },
  ];

  // ── Agent reasoning loop ──────────────────────────────────────────────────
  while (stepCount < maxSteps) {
    const stepResult = await llmProvider.runAgentStep({
      messages,
      tools,
      systemPrompt,
    });

    // Append assistant's turn to history
    messages.push(stepResult.message);

    if (!stepResult.requestsToolCalls) {
      // Model has finished investigating — break and proceed to commit
      break;
    }

    // Execute each requested tool call
    const toolCalls = stepResult.message.toolCalls || [];
    for (const tc of toolCalls) {
      const impl =
        toolImplementations[tc.name] ||
        toolImplementations[tc.name.replace(/^[a-zA-Z0-9_-]+:/, "")];
      let result: unknown;

      if (!impl) {
        result = { error: `Tool '${tc.name}' is not registered.` };
        console.warn(`[AgentLoop] Unknown tool called: ${tc.name}`);
      } else {
        try {
          result = await impl(tc.arguments);
        } catch (err: any) {
          result = { error: err?.message || "Tool execution failed" };
          console.error(`[AgentLoop] Tool '${tc.name}' threw:`, err);
        }
      }

      const traceEntry: AgentTraceStep = {
        stepIndex: stepCount,
        toolName: tc.name,
        arguments: tc.arguments,
        result,
        timestamp: new Date().toISOString(),
      };

      trace.push(traceEntry);

      // ── Write to audit_log INCREMENTALLY (per spec — not batched) ────────
      await writeAuditLog({
        merchant_id: auditContext.merchantId,
        mission_id: auditContext.missionId,
        actor_type: "gemini",
        actor_id: llmProvider.name,
        action: "agent.tool_call",
        entity_type: auditContext.entityType,
        entity_id: auditContext.entityId,
        before: { tool: tc.name, arguments: tc.arguments },
        after: { result },
      });

      // Append tool result as a 'tool' role message
      messages.push({
        role: "tool",
        content: JSON.stringify(result),
        toolCallId: tc.name, // use tool name as ID for Gemini functionResponse mapping
      });
    }

    stepCount++;
  }

  if (stepCount >= maxSteps) {
    hitStepBudget = true;
    console.warn(`[AgentLoop] Step budget of ${maxSteps} reached for entity ${auditContext.entityId}`);
  }

  // ── Final committing call — force structured output via generateStructured ─
  // Construct a user prompt summarising the conversation for the structured call.
  const conversationSummary = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "user") return `USER: ${m.content}`;
      if (m.role === "assistant" && m.toolCalls?.length) {
        return `ASSISTANT called tools: ${m.toolCalls.map((t) => t.name).join(", ")}`;
      }
      if (m.role === "assistant") return `ASSISTANT: ${m.content}`;
      if (m.role === "tool") return `TOOL RESULT: ${m.content}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");

  const budgetNote = hitStepBudget
    ? "\n\nIMPORTANT: You have reached your investigation budget. If you do not have sufficient evidence for a confident answer, say so explicitly rather than guessing. Use REQUIRES_HUMAN_REVIEW or a clear 'I could not determine' answer as appropriate."
    : "";

  const finalUserPrompt = `Based on the investigation above, provide your final structured answer.\n\nConversation transcript:\n${conversationSummary}${budgetNote}`;

  const committedResult = await llmProvider.generateStructured<T>({
    systemPrompt,
    userPrompt: finalUserPrompt,
    responseSchema: finalResponseSchema,
    temperature: 0.0,
  });

  // Append final answer to conversation history
  messages.push({
    role: "assistant",
    content: JSON.stringify(committedResult.data),
  });

  return {
    finalAnswer: committedResult.data,
    trace,
    hitStepBudget,
    conversationHistory: messages,
  };
}
