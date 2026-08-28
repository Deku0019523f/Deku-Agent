// ============================================================
// Deku Agent — Types du cœur (protocole LLM <-> Tools)
// Format interne normalisé (style OpenAI function-calling).
// Chaque provider adapte CE format vers/depuis son propre format.
// ============================================================

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema des paramètres (le sous-ensemble compatible
  // avec les 4 providers — éviter les schémas trop exotiques
  // car Gemini est le plus strict).
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque, spécifique à Gemini 3+ (voir providers/gemini.ts) : signature
   * chiffrée du raisonnement interne du modèle, à renvoyer telle quelle
   * dans l'historique. Ignoré par les autres providers.
   */
  thoughtSignature?: string;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string; // toujours stringifié (JSON.stringify si objet)
  is_error?: boolean;
}

export interface Message {
  role: Role;
  content: string | null;
  // Présent uniquement sur les messages "assistant" qui appellent des outils
  tool_calls?: ToolCall[];
  // Présent uniquement sur les messages "tool" (résultat renvoyé au LLM)
  tool_call_id?: string;
  name?: string;
  /** Idem ToolCall.thoughtSignature, pour une réponse texte (sans tool_calls). */
  thoughtSignature?: string;
}

export interface ProviderResponse {
  message: Message;
  finish_reason: "stop" | "tool_calls" | "length" | "error";
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface SendOptions {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

// Niveaux de permission pour l'exécution de commandes shell
export type PermissionLevel = "SAFE" | "CONFIRM" | "DANGEROUS";

export interface AgentConfig {
  provider: "openrouter" | "gemini" | "groq" | "openai";
  model: string;
  mode: "plan" | "act";
  auto: boolean; // deku --auto : enchaîne les actions SAFE sans confirmation
  cwd: string; // racine du projet ciblé
  maxIterations: number;
  // Profondeur de délégation sous-agent courante (0 = agent principal).
  // Incrémentée par runSubAgentLoop, jamais définie manuellement en CLI.
  subagentDepth?: number;
}
