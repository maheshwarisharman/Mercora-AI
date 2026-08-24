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

export interface LLMProvider {
  name: string;
  generateStructured<T>(req: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>>;
}
