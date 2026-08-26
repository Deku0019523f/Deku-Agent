import type { ToolDefinition } from "../types";
import { McpClient } from "./client";
import { loadMcpServers } from "./config";
import type { McpToolDefinition } from "./types";

export const MCP_TOOL_PREFIX = "mcp__";

function namespacedToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

interface McpToolRoute {
  client: McpClient;
  serverName: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Les serveurs MCP renvoient un JSON Schema arbitraire (souvent avec
 * $schema, annotations, etc. — vu en pratique sur server-filesystem).
 * On ne garde que type/properties/required, le sous-ensemble compatible
 * avec ToolDefinition["parameters"] (cf. commentaire dans types.ts sur
 * Gemini qui est le provider le plus strict). Fallback objet vide si le
 * serveur ne fournit rien d'exploitable — mieux qu'un crash.
 */
function normalizeSchema(tool: McpToolDefinition): Record<string, unknown> {
  const schema = tool.inputSchema ?? {};
  return {
    type: "object",
    properties: (schema as any).properties ?? {},
    ...((schema as any).required ? { required: (schema as any).required } : {}),
  };
}

/**
 * Registre singleton, cycle de vie = une exécution de runAgentLoop.
 * Connecte tous les serveurs configurés une fois au démarrage, résout les
 * tool_calls "mcp__<serveur>__<outil>" vers le bon client, ferme tout à
 * la fin. Un serveur qui échoue à se connecter (process introuvable,
 * timeout handshake) est journalisé et sauté — un serveur MCP cassé ne
 * doit jamais empêcher l'agent de démarrer.
 */
class McpRegistry {
  private clients = new Map<string, McpClient>();
  private routes = new Map<string, McpToolRoute>();
  private connectedCwd: string | null = null;
  private warnings: string[] = [];

  async connectAll(cwd: string): Promise<string[]> {
    // Déjà connecté pour ce même projet dans ce run — ne pas reconnecter.
    if (this.connectedCwd === cwd && this.clients.size > 0) return this.warnings;

    await this.disconnectAll();
    this.warnings = [];
    const servers = loadMcpServers(cwd);

    await Promise.all(
      Object.entries(servers).map(async ([serverName, config]) => {
        const client = new McpClient(serverName, config);
        try {
          await client.connect();
          const tools = await client.listTools();
          for (const tool of tools) {
            this.routes.set(namespacedToolName(serverName, tool.name), {
              client,
              serverName,
              originalName: tool.name,
              description: tool.description ?? `Outil "${tool.name}" du serveur MCP "${serverName}"`,
              inputSchema: normalizeSchema(tool),
            });
          }
          this.clients.set(serverName, client);
        } catch (e: any) {
          this.warnings.push(`Serveur MCP "${serverName}" indisponible: ${e?.message ?? e}`);
          client.close();
        }
      })
    );

    this.connectedCwd = cwd;
    return this.warnings;
  }

  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [namespacedName, route] of this.routes) {
      defs.push({
        name: namespacedName,
        description: `[MCP:${route.serverName}] ${route.description}`,
        parameters: route.inputSchema as ToolDefinition["parameters"],
      });
    }
    return defs;
  }

  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const route = this.routes.get(namespacedName);
    if (!route) {
      return { content: `Outil MCP inconnu: "${namespacedName}" (serveur déconnecté ou jamais listé).`, isError: true };
    }
    try {
      const result = await route.client.callTool(route.originalName, args);
      const text = (result.content ?? [])
        .map((block) => (block.type === "text" ? block.text ?? "" : `[bloc non-texte: ${block.type}]`))
        .join("\n");
      return { content: text || "(réponse vide)", isError: Boolean(result.isError) };
    } catch (e: any) {
      return { content: `Erreur d'appel MCP "${namespacedName}": ${e?.message ?? e}`, isError: true };
    }
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.routes.clear();
    this.connectedCwd = null;
  }
}

export const mcpRegistry = new McpRegistry();
