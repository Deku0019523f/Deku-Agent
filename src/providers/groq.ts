import { createOpenAICompatibleProvider } from "./openai-compatible";

export const groqProvider = createOpenAICompatibleProvider({
  id: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKeyEnv: "GROQ_API_KEY",
});
