import type { SendOptions, ProviderResponse } from "../types";

/**
 * Interface commune à tous les providers LLM.
 * Chaque adaptateur (openrouter.ts, gemini.ts, groq.ts, openai.ts)
 * traduit le format interne <-> le format natif de son API,
 * pour que l'Agent Engine n'ait JAMAIS à connaître ces différences.
 */
export interface LLMProvider {
  readonly id: "openrouter" | "gemini" | "groq" | "openai";
  readonly supportsToolCalling: boolean;

  send(options: SendOptions): Promise<ProviderResponse>;
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    message: string,
    public cause?: unknown
  ) {
    super(`[${provider}] ${message}`);
  }
}
