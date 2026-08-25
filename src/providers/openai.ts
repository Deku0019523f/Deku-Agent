import { createOpenAICompatibleProvider } from "./openai-compatible";

export const openaiProvider = createOpenAICompatibleProvider({
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
});
