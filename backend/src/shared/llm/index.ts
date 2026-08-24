import { GeminiProvider } from "./gemini";
import type { LLMProvider } from "./types";

export * from "./types";

/**
 * Factory function to retrieve the configured LLM provider.
 * Throws a clear error if an unsupported provider is requested.
 */
export function getLLMProvider(purpose: "investigate" | "judge"): LLMProvider {
  const providerName = process.env.LLM_PROVIDER ?? "gemini";
  if (providerName === "gemini") {
    return new GeminiProvider(purpose);
  }
  throw new Error(`Unknown LLM provider: ${providerName}`);
}
