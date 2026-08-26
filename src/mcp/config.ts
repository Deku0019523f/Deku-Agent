import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpConfigFile, McpServerConfig } from "./types";

/**
 * Charge la config MCP : <cwd>/.deku-agent/mcp.json (projet) fusionné par
 * dessus ~/.deku-agent/mcp.json (global) — un serveur défini aux deux
 * niveaux, la version projet gagne. Format identique à l'esprit de
 * permissions.json (même dossier .deku-agent, mêmes conventions).
 *
 * Exemple de fichier:
 * {
 *   "servers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/chemin"],
 *       "enabled": true
 *     }
 *   }
 * }
 */
export function loadMcpServers(cwd: string): Record<string, McpServerConfig> {
  const globalConfig = readConfigFile(join(homedir(), ".deku-agent", "mcp.json"));
  const projectConfig = readConfigFile(join(cwd, ".deku-agent", "mcp.json"));

  const merged: Record<string, McpServerConfig> = { ...(globalConfig?.servers ?? {}) };
  for (const [name, cfg] of Object.entries(projectConfig?.servers ?? {})) {
    merged[name] = cfg;
  }

  const enabled: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(merged)) {
    if (cfg.enabled === false) continue;
    if (!cfg.command) continue; // config malformée, ignorée silencieusement
    enabled[name] = cfg;
  }
  return enabled;
}

function readConfigFile(path: string): McpConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null; // fichier invalide : ignoré, pas de crash agent pour une erreur de config
  }
}
