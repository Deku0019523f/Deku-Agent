import type { ToolCall, ToolDefinition, ToolResult, AgentConfig } from "../types";
import {
  readFileTool,
  writeFileTool,
  listFilesTool,
  executeReadFile,
  executeWriteFile,
  executeListFiles,
} from "./filesystem";
import { runCommandTool, runCommand } from "./terminal";
import { grepSearchTool, findFilesTool, executeGrepSearch, executeFindFiles } from "./search";
import { classifyCommand, isSensitivePath } from "./permissions";
import { GIT_TOOLS, GIT_SHELL_TOOL_NAMES, buildGitCommand } from "./git";
import {
  createSnapshot,
  listProjectSnapshots,
  restoreSnapshot,
  formatSnapshotList,
} from "./snapshots";
import {
  spawnSubagentTool,
  DEFAULT_SUBAGENT_MAX_ITERATIONS,
  HARD_CAP_SUBAGENT_MAX_ITERATIONS,
} from "./subagent";
// Import circulaire assumé avec agent/subagent.ts (qui importe ALL_TOOLS et
// executeTool d'ici) : sûr car runSubAgentLoop n'est appelée que depuis le
// corps de executeTool, jamais au chargement du module. Voir le commentaire
// dans agent/subagent.ts pour le détail.
import { runSubAgentLoop } from "../agent/subagent";
import { mcpRegistry, isMcpToolName } from "../mcp/registry";
import { pluginRegistry, isPluginToolName } from "../plugins/registry";

export const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  runCommandTool,
  grepSearchTool,
  findFilesTool,
  ...GIT_TOOLS,
  spawnSubagentTool,
];

/**
 * Liste d'outils réellement disponible pour CE run : ALL_TOOLS (statique)
 * + les outils exposés par les serveurs MCP connectés + les outils des
 * plugins chargés. À appeler après mcpRegistry.connectAll() et
 * pluginRegistry.loadAll() (fait par runAgentLoop au démarrage) — sinon
 * ces deux registres sont simplement vides et on retombe sur ALL_TOOLS.
 */
export function getRuntimeTools(): ToolDefinition[] {
  return [...ALL_TOOLS, ...mcpRegistry.getToolDefinitions(), ...pluginRegistry.getToolDefinitions()];
}

export type ConfirmFn = (
  question: string
) => Promise<boolean> | boolean;

export interface ExecuteToolOptions {
  sessionId?: string | null;
}

/**
 * Exécute un tool call en respectant la politique de permissions.
 * `confirm` est fourni par le CLI (prompt interactif) — en mode --auto,
 * les commandes SAFE passent sans lui, CONFIRM/DANGEROUS l'appellent quand même.
 *
 * V0.5 : un snapshot Git automatique est pris avant toute écriture
 * effective (write_file) et avant toute commande DANGEROUS approuvée,
 * pour permettre un rollback via l'outil git_rollback.
 */
export async function executeTool(
  call: ToolCall,
  config: AgentConfig,
  confirm: ConfirmFn,
  options: ExecuteToolOptions = {}
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "read_file": {
        const content = await executeReadFile(
          config.cwd,
          call.arguments as { path: string }
        );
        return ok(call, content);
      }

      case "write_file": {
        const args = call.arguments as { path: string; content: string };
        if (config.mode === "plan") {
          return ok(
            call,
            `[PLAN MODE] Écriture simulée (non appliquée): ${args.path}`
          );
        }

        // Fichier sensible (.env, .git/, lockfiles...) : confirmation
        // obligatoire même en --auto.
        if (isSensitivePath(args.path)) {
          const allowed = await confirm(
            `⚠️  Écriture sur un fichier sensible: "${args.path}"\nAutoriser ?`
          );
          if (!allowed) return ok(call, "Écriture refusée par l'utilisateur.");
        }

        const snapshot = await createSnapshot(
          config.cwd,
          `avant write_file: ${args.path}`,
          "write_file",
          options.sessionId
        );

        const result = await executeWriteFile(config.cwd, args);
        return ok(
          call,
          snapshot ? `${result} (snapshot #${snapshot.id})` : result
        );
      }

      case "list_files": {
        const result = await executeListFiles(
          config.cwd,
          call.arguments as { path: string }
        );
        return ok(call, result);
      }

      case "run_command": {
        const args = call.arguments as { command: string };
        return await executeShellWithPermission(call, args.command, config, confirm, options);
      }

      case "grep_search": {
        const result = await executeGrepSearch(
          config.cwd,
          call.arguments as { pattern: string; path?: string; file_extension?: string }
        );
        return ok(call, result);
      }

      case "find_files": {
        const result = await executeFindFiles(
          config.cwd,
          call.arguments as { name_pattern: string; path?: string }
        );
        return ok(call, result);
      }

      case "git_rollback": {
        return await handleGitRollback(call, config, confirm);
      }

      case "spawn_subagent": {
        const args = call.arguments as { objective: string; max_iterations?: number };
        const result = await runSubAgentLoop(
          args.objective,
          config,
          confirm,
          args.max_iterations,
          HARD_CAP_SUBAGENT_MAX_ITERATIONS,
          DEFAULT_SUBAGENT_MAX_ITERATIONS
        );
        return ok(
          call,
          `${result.summary}\n\n[sous-agent: ${result.iterationsUsed} itération(s), ${result.completed ? "conclu" : "non conclu"}]`
        );
      }

      default: {
        if (GIT_SHELL_TOOL_NAMES.has(call.name)) {
          const command = buildGitCommand(call.name, call.arguments);
          return await executeShellWithPermission(call, command, config, confirm, options);
        }
        if (isMcpToolName(call.name)) {
          const result = await mcpRegistry.callTool(call.name, call.arguments);
          return result.isError ? err(call, result.content) : ok(call, result.content);
        }
        if (isPluginToolName(call.name)) {
          const result = await pluginRegistry.callTool(call.name, call.arguments, config.cwd, config);
          return result.isError ? err(call, result.content) : ok(call, result.content);
        }
        return err(call, `Outil inconnu: ${call.name}`);
      }
    }
  } catch (e: any) {
    return err(call, e?.message ?? String(e));
  }
}

/**
 * git_rollback ne passe pas par le chemin shell générique : 'list' est en
 * lecture seule (SAFE), 'restore' réécrit le working tree et demande donc
 * TOUJOURS confirmation, quel que soit --auto (même logique que DANGEROUS).
 */
async function handleGitRollback(
  call: ToolCall,
  config: AgentConfig,
  confirm: ConfirmFn
): Promise<ToolResult> {
  const args = call.arguments as { action: "list" | "restore"; snapshot_id?: number };

  if (args.action === "list") {
    const snapshots = await listProjectSnapshots(config.cwd);
    return ok(call, formatSnapshotList(snapshots));
  }

  if (args.action === "restore") {
    if (args.snapshot_id === undefined) {
      return err(call, "snapshot_id requis pour action='restore' (voir action='list').");
    }
    if (config.mode === "plan") {
      return ok(
        call,
        `[PLAN MODE] Restauration proposée (non appliquée): snapshot #${args.snapshot_id}`
      );
    }

    const allowed = await confirm(
      `⚠️  Restaurer le snapshot #${args.snapshot_id} ? Les modifications non commitées ET les fichiers créés depuis seront perdus.`
    );
    if (!allowed) return ok(call, "Restauration refusée par l'utilisateur.");

    const result = await restoreSnapshot(config.cwd, args.snapshot_id);
    if (!result.ok) return err(call, result.error);
    return ok(call, `Working tree restauré: "${result.label}" (snapshot #${args.snapshot_id})`);
  }

  return err(call, `Action git_rollback inconnue: ${(args as any).action}`);
}

/**
 * Chemin d'exécution partagé par run_command ET les outils git_* :
 * classification SAFE/CONFIRM/DANGEROUS, respect du mode plan,
 * demande de confirmation si nécessaire, snapshot avant exécution
 * des commandes DANGEROUS approuvées, puis exécution.
 */
async function executeShellWithPermission(
  call: ToolCall,
  command: string,
  config: AgentConfig,
  confirm: ConfirmFn,
  options: ExecuteToolOptions
): Promise<ToolResult> {
  const level = classifyCommand(command, config.cwd);

  if (config.mode === "plan") {
    return ok(call, `[PLAN MODE] Commande proposée (non exécutée): ${command} [${level}]`);
  }

  if (level === "DANGEROUS") {
    const allowed = await confirm(`⚠️  Commande DANGEROUS: "${command}"\nAutoriser ?`);
    if (!allowed) return ok(call, "Commande refusée par l'utilisateur.");
    // Snapshot juste avant d'exécuter une commande destructive approuvée.
    await createSnapshot(config.cwd, `avant commande DANGEROUS: ${command}`, "dangerous_command", options.sessionId);
  } else if (level === "CONFIRM") {
    const allowed = await confirm(`Autoriser: "${command}" ?`);
    if (!allowed) return ok(call, "Commande refusée par l'utilisateur.");
  }
  // SAFE (ou CONFIRM/DANGEROUS validées) → exécution, quel que soit --auto

  const result = await runCommand(config.cwd, command);
  return ok(
    call,
    JSON.stringify({
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 4000),
      stderr: result.stderr.slice(0, 2000),
    })
  );
}

function ok(call: ToolCall, content: string): ToolResult {
  return { tool_call_id: call.id, name: call.name, content };
}

function err(call: ToolCall, message: string): ToolResult {
  return {
    tool_call_id: call.id,
    name: call.name,
    content: `Erreur: ${message}`,
    is_error: true,
  };
}
