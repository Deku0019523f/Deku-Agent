import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderId } from "../providers";

const CONFIG_DIR = join(homedir(), ".deku-agent");
const CONFIG_PATH = join(CONFIG_DIR, "credentials.json");

export const PROVIDER_ENV_VAR: Record<ProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
};

export const PROVIDER_IDS: ProviderId[] = ["openrouter", "gemini", "groq", "openai"];

/** Modèle de repli si aucun n'a jamais été choisi pour ce provider. */
export const FALLBACK_MODEL: Record<ProviderId, string> = {
  openrouter: "anthropic/claude-3.5-sonnet",
  groq: "llama-3.3-70b-versatile",
  openai: "gpt-4o-mini",
  gemini: "gemini-1.5-pro",
};

export interface StoredConfig {
  defaultProvider?: ProviderId;
  /** Dernier modèle choisi pour chaque provider (mémorisé indépendamment,
   *  pour retrouver son choix en changeant de provider puis en y revenant). */
  models?: Partial<Record<ProviderId, string>>;
  apiKeys?: Partial<Record<ProviderId, string>>;
}

/**
 * ~/.deku-agent/credentials.json — clés API en clair, permissions 600.
 * Jamais dans le dossier projet, jamais dans .deku-agent/ versionnable
 * (mcp.json, permissions.json, plugins/ vivent côté projet ; ceci est
 * strictement global et personnel, comme ~/.aws/credentials).
 */
export function loadConfig(): StoredConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {}; // fichier corrompu : on repart d'une config vide plutôt que de crasher
  }
}

export function saveConfig(config: StoredConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600); // au cas où umask aurait affaibli le mode au premier write
  } catch {
    // best-effort : pas fatal si chmod échoue (FS exotique), le contenu est déjà écrit
  }
}

export function setApiKey(provider: ProviderId, apiKey: string): StoredConfig {
  const config = loadConfig();
  config.apiKeys = { ...config.apiKeys, [provider]: apiKey };
  saveConfig(config);
  return config;
}

export function removeApiKey(provider: ProviderId): StoredConfig {
  const config = loadConfig();
  if (config.apiKeys) delete config.apiKeys[provider];
  saveConfig(config);
  return config;
}

export function setDefaultProviderModel(provider: ProviderId, model: string): StoredConfig {
  const config = loadConfig();
  config.defaultProvider = provider;
  config.models = { ...config.models, [provider]: model };
  saveConfig(config);
  return config;
}

/**
 * Injecte les clés stockées dans process.env, SANS écraser une variable
 * déjà exportée par le shell — l'export manuel reste toujours prioritaire
 * sur la config sauvegardée, cohérent avec le README (export = méthode
 * "officielle", `deku config` = confort en plus, pas un remplacement).
 */
export function applyStoredKeysToEnv(config: StoredConfig = loadConfig()): void {
  for (const provider of PROVIDER_IDS) {
    const envVar = PROVIDER_ENV_VAR[provider];
    if (!process.env[envVar] && config.apiKeys?.[provider]) {
      process.env[envVar] = config.apiKeys[provider]!;
    }
  }
}

/** Résout provider/modèle effectifs : flag CLI > config sauvegardée > repli codé en dur. */
export function resolveProviderAndModel(
  cliProvider: string | undefined,
  cliModel: string | undefined,
  config: StoredConfig = loadConfig()
): { provider: ProviderId; model: string } {
  const provider = (cliProvider as ProviderId) ?? config.defaultProvider ?? "openrouter";
  const model = cliModel ?? config.models?.[provider] ?? FALLBACK_MODEL[provider];
  return { provider, model };
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}
