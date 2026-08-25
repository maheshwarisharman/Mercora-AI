// ─── Single-shot Structured Completion ────────────────────────────────────────

export interface StructuredCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  responseSchema: unknown; // JSON Schema object, provider-agnostic shape
  temperature?: number;
}

export interface StructuredCompletionResult<T> {
  data: T;
  rawResponse: unknown; // keep raw provider response for audit/debugging
  model: string;
  provider: string;
}

// ─── Agent / Tool-calling Types ───────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  /** Must be specific enough that the model can decide when to use it without guessing. */
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: unknown;
}

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  role: AgentRole;
  /** For 'assistant', this is empty/omitted when the message is purely tool calls. */
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** Set on 'tool' role messages: which call ID this result answers. */
  toolCallId?: string;
  /** Preserved raw parts from model response (required for thought_signatures / reasoning parts in Gemini 2.5 / 3.x) */
  rawParts?: unknown[];
}

export interface AgentStepRequest {
  messages: AgentMessage[];
  tools: ToolDefinition[];
  systemPrompt: string;
}

export interface AgentStepResult {
  /** The assistant's turn: either tool calls, or final text. */
  message: AgentMessage;
  /** true if message.toolCalls is non-empty. */
  requestsToolCalls: boolean;
}

/** One entry in the agent's reasoning trace — one tool invocation + result. */
export interface AgentTraceStep {
  stepIndex: number;
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  timestamp: string;
}

// ─── Provider Interface ────────────────────────────────────────────────────────

export interface LLMProvider {
  name: string;
  generateStructured<T>(req: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>>;
  runAgentStep(req: AgentStepRequest): Promise<AgentStepResult>;
}
