import type { LLMProvider } from "./base";
import { ProviderError } from "./base";
import type {
  SendOptions,
  ProviderResponse,
  Message,
  ToolDefinition,
  ToolCall,
} from "../types";

/**
 * Gemini a un format natif différent des APIs style OpenAI :
 * - roles "user" / "model" (pas "assistant")
 * - pas de rôle "tool" : les résultats d'outils sont un message
 *   "user" contenant une part functionResponse
 * - les tool calls arrivent en parts[].functionCall (pas de "id"
 *   natif → on en génère un côté Deku pour rester compatible avec
 *   le protocole interne)
 * - schema JSON des tools plus strict (pas de $ref, pas de formats
 *   exotiques) : à garder en tête en V0.2 quand on définira les tools.
 */
export const geminiProvider: LLMProvider = {
  id: "gemini",
  supportsToolCalling: true,

  async send(options: SendOptions): Promise<ProviderResponse> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ProviderError("gemini", "Variable GEMINI_API_KEY manquante");
    }

    const systemMessages = options.messages.filter((m) => m.role === "system");
    const conversation = options.messages.filter((m) => m.role !== "system");

    const body: any = {
      contents: conversation.map(toGeminiContent),
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.max_tokens ?? 4096,
      },
    };

    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join("\n") }],
      };
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = [
        { functionDeclarations: options.tools.map(toGeminiTool) },
      ];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError("gemini", `HTTP ${res.status}: ${text}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new ProviderError("gemini", "Réponse vide (pas de candidates[])");
    }

    const parts: any[] = candidate.content?.parts ?? [];
    const textPart = parts.find((p) => p.text)?.text ?? null;
    const functionCalls = parts.filter((p) => p.functionCall);

    const tool_calls: ToolCall[] | undefined =
      functionCalls.length > 0
        ? functionCalls.map((p, i) => ({
            id: `gemini-call-${Date.now()}-${i}`,
            name: p.functionCall.name,
            arguments: p.functionCall.args ?? {},
          }))
        : undefined;

    const message: Message = {
      role: "assistant",
      content: textPart,
      tool_calls,
    };

    return {
      message,
      finish_reason: tool_calls
        ? "tool_calls"
        : candidate.finishReason === "MAX_TOKENS"
        ? "length"
        : "stop",
      usage: data.usageMetadata
        ? {
            input_tokens: data.usageMetadata.promptTokenCount,
            output_tokens: data.usageMetadata.candidatesTokenCount,
          }
        : undefined,
    };
  },
};

function toGeminiContent(m: Message) {
  if (m.role === "tool") {
    // Gemini attend le résultat d'un tool comme un message "user"
    // avec une part functionResponse (pas de rôle "tool" dédié).
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: m.name,
            response: { result: safeParse(m.content) },
          },
        },
      ],
    };
  }
  if (m.role === "assistant" && m.tool_calls) {
    return {
      role: "model",
      parts: m.tool_calls.map((tc) => ({
        functionCall: { name: tc.name, args: tc.arguments },
      })),
    };
  }
  return {
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content ?? "" }],
  };
}

function toGeminiTool(t: ToolDefinition) {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  };
}

function safeParse(content: string | null) {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}
