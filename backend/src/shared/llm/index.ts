import { GeminiProvider } from "./gemini";
import type { LLMProvider } from "./types";

export * from "./types";

/**
 * Factory function to retrieve the configured LLM provider.
 * Throws a clear error if an unsupported provider is requested — this is intentional:
 * setting LLM_PROVIDER to an unimplemented value must fail loudly at the factory,
 * not silently degrade elsewhere.
 */
export function getLLMProvider(purpose: "investigate" | "judge" | "summary"): LLMProvider {
  const providerName = process.env.LLM_PROVIDER ?? "gemini";
  if (providerName === "gemini") {
    return new GeminiProvider(purpose);
  }
  throw new Error(
    `Unknown LLM provider: "${providerName}". Supported providers: ["gemini"]. Check your LLM_PROVIDER environment variable.`
  );
}
