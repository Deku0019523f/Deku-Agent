import type { ToolCall, ToolDefinition, ToolResult, AgentConfig } from "../types";
import {
  readFileTool,
  writeFileTool,
  listFilesTool,
  executeReadFile,
  executeWriteFile,
  executeListFiles,
} from "./filesystem";
import { runCommandTool, runCommand, classifyCommand } from "./terminal";
import { grepSearchTool, findFilesTool, executeGrepSearch, executeFindFiles } from "./search";
import { GIT_TOOLS, GIT_TOOL_NAMES, buildGitCommand } from "./git";

export const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  runCommandTool,
  grepSearchTool,
  findFilesTool,
  ...GIT_TOOLS,
];

export type ConfirmFn = (
  question: string
) => Promise<boolean> | boolean;

/**
 * Exécute un tool call en respectant la politique de permissions.
 * `confirm` est fourni par le CLI (prompt interactif) — en mode --auto,
 * les commandes SAFE passent sans lui, CONFIRM/DANGEROUS l'appellent quand même.
 */
export async function executeTool(
  call: ToolCall,
  config: AgentConfig,
  confirm: ConfirmFn
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
        const result = await executeWriteFile(config.cwd, args);
        return ok(call, result);
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
        return await executeShellWithPermission(call, args.command, config, confirm);
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

      default: {
        if (GIT_TOOL_NAMES.has(call.name)) {
          const command = buildGitCommand(call.name, call.arguments);
          return await executeShellWithPermission(call, command, config, confirm);
        }
        return err(call, `Outil inconnu: ${call.name}`);
      }
    }
  } catch (e: any) {
    return err(call, e?.message ?? String(e));
  }
}

/**
 * Chemin d'exécution partagé par run_command ET les outils git_* :
 * classification SAFE/CONFIRM/DANGEROUS, respect du mode plan,
 * demande de confirmation si nécessaire, puis exécution.
 */
async function executeShellWithPermission(
  call: ToolCall,
  command: string,
  config: AgentConfig,
  confirm: ConfirmFn
): Promise<ToolResult> {
  const level = classifyCommand(command);

  if (config.mode === "plan") {
    return ok(call, `[PLAN MODE] Commande proposée (non exécutée): ${command} [${level}]`);
  }

  if (level === "DANGEROUS") {
    const allowed = await confirm(`⚠️  Commande DANGEROUS: "${command}"\nAutoriser ?`);
    if (!allowed) return ok(call, "Commande refusée par l'utilisateur.");
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
