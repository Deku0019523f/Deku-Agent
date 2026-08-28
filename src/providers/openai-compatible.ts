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
 * OpenRouter, Groq et OpenAI exposent tous une API compatible
 * "chat/completions" façon OpenAI. On factorise donc l'adaptateur
 * plutôt que de dupliquer le code 3 fois.
 */
export function createOpenAICompatibleProvider(config: {
  id: "openrouter" | "groq" | "openai";
  baseUrl: string;
  apiKeyEnv: string;
  extraHeaders?: Record<string, string>;
}): LLMProvider {
  return {
    id: config.id,
    supportsToolCalling: true,

    async send(options: SendOptions): Promise<ProviderResponse> {
      const apiKey = process.env[config.apiKeyEnv];
      if (!apiKey) {
        throw new ProviderError(
          config.id,
          `Variable d'environnement ${config.apiKeyEnv} manquante`
        );
      }

      const body = {
        model: options.model,
        messages: options.messages.map(toOpenAIMessage),
        tools: options.tools?.map(toOpenAITool),
        temperature: options.temperature ?? 0.2,
        max_tokens: options.max_tokens ?? 4096,
      };

      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(config.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new ProviderError(config.id, `HTTP ${res.status}: ${text}`);
      }

      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      if (!choice) {
        throw new ProviderError(config.id, "Réponse vide (pas de choices[])");
      }

      const msg = choice.message;
      const tool_calls: ToolCall[] | undefined = msg.tool_calls?.map(
        (tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeJsonParse(tc.function.arguments),
        })
      );

      const message: Message = {
        role: "assistant",
        content: msg.content ?? null,
        tool_calls,
      };

      return {
        message,
        finish_reason: tool_calls
          ? "tool_calls"
          : choice.finish_reason === "length"
          ? "length"
          : "stop",
        usage: data.usage
          ? {
              input_tokens: data.usage.prompt_tokens,
              output_tokens: data.usage.completion_tokens,
            }
          : undefined,
      };
    },
  };
}

function toOpenAIMessage(m: Message) {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.tool_call_id,
      name: m.name,
      content: m.content,
    };
  }
  if (m.role === "assistant" && m.tool_calls) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function toOpenAITool(t: ToolDefinition) {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
