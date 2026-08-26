import type { ToolDefinition, AgentConfig } from "../types";

/**
 * Contexte passé à chaque appel d'outil de plugin. Volontairement minimal
 * (pas d'accès direct aux internals de l'agent) — un plugin est du code
 * qui tourne EN PROCESS, sans sandbox. Documenté clairement : on ne
 * charge que des plugins qu'on a écrits ou en qui on a confiance, comme
 * pour n'importe quel package npm exécuté localement.
 */
export interface DekuPluginContext {
  cwd: string;
  config: AgentConfig;
}

export interface DekuPlugin {
  name: string;
  description?: string;
  tools: ToolDefinition[];
  executeTool(name: string, args: Record<string, unknown>, ctx: DekuPluginContext): Promise<string>;
}

export interface PluginManifest {
  name: string;
  description?: string;
  entry?: string; // défaut "index.ts"
  enabled?: boolean; // défaut true
}
