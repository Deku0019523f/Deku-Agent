import type { LLMProvider } from "./base";
import { openrouterProvider } from "./openrouter";
import { geminiProvider } from "./gemini";
import { groqProvider } from "./groq";
import { openaiProvider } from "./openai";

export type ProviderId = "openrouter" | "gemini" | "groq" | "openai";

const registry: Record<ProviderId, LLMProvider> = {
  openrouter: openrouterProvider,
  gemini: geminiProvider,
  groq: groqProvider,
  openai: openaiProvider,
};

export function getProvider(id: ProviderId): LLMProvider {
  const provider = registry[id];
  if (!provider) {
    throw new Error(
      `Provider inconnu: "${id}". Providers disponibles: ${Object.keys(
        registry
      ).join(", ")}`
    );
  }
  return provider;
}

export * from "./base";
