import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { ToolDefinition, AgentConfig } from "../types";
import type { DekuPlugin, PluginManifest, DekuPluginContext } from "./types";

export const PLUGIN_TOOL_PREFIX = "plugin__";

function namespacedToolName(pluginName: string, toolName: string): string {
  return `${PLUGIN_TOOL_PREFIX}${pluginName}__${toolName}`;
}

export function isPluginToolName(name: string): boolean {
  return name.startsWith(PLUGIN_TOOL_PREFIX);
}

interface PluginToolRoute {
  plugin: DekuPlugin;
  originalName: string;
}

/**
 * Plugins = extensibilité en-process, sans sandbox : un plugin est un
 * module TS/JS local (jamais téléchargé automatiquement) exportant par
 * défaut un objet DekuPlugin. Découverte dans
 * <cwd>/.deku-agent/plugins/<nom>/{plugin.json,index.ts} (projet) et
 * ~/.deku-agent/plugins/<nom>/... (global) — le projet ne peut pas
 * écraser un plugin global de même nom, les deux coexistent (noms
 * distincts en pratique, sinon le premier chargé gagne le namespace
 * d'outils et le second est journalisé en conflit).
 *
 * Confiance : contrairement à MCP (process séparé, surface d'attaque
 * limitée à stdin/stdout), un plugin s'exécute avec les mêmes privilèges
 * que Deku Agent lui-même. Ne placer dans .deku-agent/plugins/ que du
 * code écrit ou audité soi-même.
 */
class PluginRegistry {
  private plugins: DekuPlugin[] = [];
  private routes = new Map<string, PluginToolRoute>();
  private loadedCwd: string | null = null;
  private warnings: string[] = [];

  async loadAll(cwd: string): Promise<string[]> {
    if (this.loadedCwd === cwd && this.plugins.length > 0) return this.warnings;

    this.plugins = [];
    this.routes.clear();
    this.warnings = [];

    const dirs = [
      ...listPluginDirs(join(homedir(), ".deku-agent", "plugins")),
      ...listPluginDirs(join(cwd, ".deku-agent", "plugins")),
    ];

    for (const pluginDir of dirs) {
      try {
        const manifest = readManifest(pluginDir);
        if (!manifest || manifest.enabled === false) continue;

        const entryFile = join(pluginDir, manifest.entry ?? "index.ts");
        if (!existsSync(entryFile)) {
          this.warnings.push(`Plugin "${manifest.name}": fichier d'entrée introuvable (${entryFile}).`);
          continue;
        }

        const mod = await import(pathToFileURL(entryFile).href);
        const plugin: DekuPlugin | undefined = mod.default ?? mod.plugin;

        if (!isValidPlugin(plugin)) {
          this.warnings.push(`Plugin "${manifest.name}": export invalide (attendu DekuPlugin en default export).`);
          continue;
        }

        if (this.plugins.some((p) => p.name === plugin.name)) {
          this.warnings.push(`Plugin "${plugin.name}": nom déjà chargé, ignoré (conflit projet/global).`);
          continue;
        }

        this.plugins.push(plugin);
        for (const tool of plugin.tools) {
          this.routes.set(namespacedToolName(plugin.name, tool.name), { plugin, originalName: tool.name });
        }
      } catch (e: any) {
        this.warnings.push(`Plugin dans "${pluginDir}" non chargé: ${e?.message ?? e}`);
      }
    }

    this.loadedCwd = cwd;
    return this.warnings;
  }

  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [namespacedName, route] of this.routes) {
      const original = route.plugin.tools.find((t) => t.name === route.originalName);
      if (!original) continue;
      defs.push({
        name: namespacedName,
        description: `[Plugin:${route.plugin.name}] ${original.description}`,
        parameters: original.parameters,
      });
    }
    return defs;
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    cwd: string,
    config: AgentConfig
  ): Promise<{ content: string; isError: boolean }> {
    const route = this.routes.get(namespacedName);
    if (!route) {
      return { content: `Outil de plugin inconnu: "${namespacedName}".`, isError: true };
    }
    const ctx: DekuPluginContext = { cwd, config };
    try {
      const content = await route.plugin.executeTool(route.originalName, args, ctx);
      return { content, isError: false };
    } catch (e: any) {
      return { content: `Erreur plugin "${route.plugin.name}.${route.originalName}": ${e?.message ?? e}`, isError: true };
    }
  }

  reset(): void {
    this.plugins = [];
    this.routes.clear();
    this.loadedCwd = null;
  }
}

function listPluginDirs(pluginsRoot: string): string[] {
  if (!existsSync(pluginsRoot)) return [];
  try {
    return readdirSync(pluginsRoot)
      .map((entry) => join(pluginsRoot, entry))
      .filter((full) => {
        try {
          return statSync(full).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function readManifest(pluginDir: string): PluginManifest | null {
  const manifestPath = join(pluginDir, "plugin.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
    if (!manifest.name) return null;
    return manifest;
  } catch {
    return null;
  }
}

function isValidPlugin(plugin: unknown): plugin is DekuPlugin {
  if (!plugin || typeof plugin !== "object") return false;
  const p = plugin as Partial<DekuPlugin>;
  return (
    typeof p.name === "string" &&
    Array.isArray(p.tools) &&
    typeof p.executeTool === "function"
  );
}

export const pluginRegistry = new PluginRegistry();
