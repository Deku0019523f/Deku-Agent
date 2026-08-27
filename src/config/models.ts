import type { ProviderId } from "../providers";

export interface ModelChoice {
  id: string;
  label?: string;
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Listes de repli, utilisées si l'appel réseau au catalogue du provider
 * échoue (pas de connexion, endpoint changé, clé invalide). Volontairement
 * courtes et non exhaustives — l'utilisateur peut toujours saisir un id de
 * modèle personnalisé dans l'assistant `deku config`. À rafraîchir de
 * temps en temps, mais leur obsolescence n'est jamais bloquante.
 */
const STATIC_FALLBACK: Record<ProviderId, ModelChoice[]> = {
  openrouter: [
    { id: "anthropic/claude-3.5-sonnet" },
    { id: "anthropic/claude-3.5-haiku" },
    { id: "openai/gpt-4o" },
    { id: "openai/gpt-4o-mini" },
    { id: "google/gemini-flash-1.5" },
    { id: "meta-llama/llama-3.3-70b-instruct" },
    { id: "deepseek/deepseek-chat" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile" },
    { id: "llama-3.1-8b-instant" },
    { id: "mixtral-8x7b-32768" },
    { id: "gemma2-9b-it" },
  ],
  openai: [
    { id: "gpt-4o" },
    { id: "gpt-4o-mini" },
    { id: "gpt-4.1" },
    { id: "gpt-4.1-mini" },
    { id: "o3-mini" },
  ],
  gemini: [
    { id: "gemini-1.5-pro" },
    { id: "gemini-1.5-flash" },
    { id: "gemini-2.0-flash" },
  ],
};

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Récupère le catalogue de modèles pour un provider. `apiKey` est requis
 * pour groq/openai/gemini (endpoint authentifié) ; OpenRouter expose son
 * catalogue publiquement. Ne lève JAMAIS : retombe sur STATIC_FALLBACK en
 * cas d'échec, avec un flag `dynamic: false` pour que l'appelant puisse
 * prévenir l'utilisateur que la liste peut être incomplète/datée.
 */
export async function fetchModels(
  provider: ProviderId,
  apiKey?: string
): Promise<{ models: ModelChoice[]; dynamic: boolean }> {
  try {
    switch (provider) {
      case "openrouter": {
        const data = await fetchJson("https://openrouter.ai/api/v1/models");
        const models: ModelChoice[] = (data.data ?? []).map((m: any) => ({ id: m.id, label: m.name }));
        if (models.length === 0) throw new Error("catalogue vide");
        return { models, dynamic: true };
      }

      case "groq": {
        if (!apiKey) throw new Error("clé API requise");
        const data = await fetchJson("https://api.groq.com/openai/v1/models", {
          Authorization: `Bearer ${apiKey}`,
        });
        const models: ModelChoice[] = (data.data ?? []).map((m: any) => ({ id: m.id }));
        if (models.length === 0) throw new Error("catalogue vide");
        return { models, dynamic: true };
      }

      case "openai": {
        if (!apiKey) throw new Error("clé API requise");
        const data = await fetchJson("https://api.openai.com/v1/models", {
          Authorization: `Bearer ${apiKey}`,
        });
        // L'API renvoie aussi les modèles d'embedding/whisper/tts — on filtre
        // aux familles de chat connues pour garder une liste exploitable.
        const CHAT_PATTERNS = /^(gpt-|o1|o3|o4|chatgpt)/i;
        const models: ModelChoice[] = (data.data ?? [])
          .map((m: any) => ({ id: m.id }))
          .filter((m: ModelChoice) => CHAT_PATTERNS.test(m.id));
        if (models.length === 0) throw new Error("catalogue vide après filtrage");
        return { models, dynamic: true };
      }

      case "gemini": {
        if (!apiKey) throw new Error("clé API requise");
        const data = await fetchJson(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        const models: ModelChoice[] = (data.models ?? [])
          .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
          .map((m: any) => ({ id: String(m.name).replace(/^models\//, ""), label: m.displayName }));
        if (models.length === 0) throw new Error("catalogue vide");
        return { models, dynamic: true };
      }
    }
  } catch {
    // Réseau indisponible, endpoint changé, clé invalide... on ne bloque
    // jamais l'assistant de config pour ça.
  }
  return { models: STATIC_FALLBACK[provider], dynamic: false };
}
