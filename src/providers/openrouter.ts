import { createOpenAICompatibleProvider } from "./openai-compatible";

export const openrouterProvider = createOpenAICompatibleProvider({
  id: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY",
  extraHeaders: {
    "HTTP-Referer": "https://deku-agent.local",
    "X-Title": "Deku Agent",
  },
});
