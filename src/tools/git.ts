import type { ToolDefinition } from "../types";

/**
 * Chaque fonction construit UNIQUEMENT la commande git (string).
 * L'exécution passe par le même chemin que run_command (classifyCommand
 * + confirm si besoin) — voir tools/index.ts. On ne duplique donc pas
 * la logique de permissions ici.
 */

export const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description: "Affiche l'état du repository Git (fichiers modifiés/ajoutés/non suivis).",
  parameters: { type: "object", properties: {} },
};

export const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description: "Affiche les différences non commitées. Optionnellement pour un fichier précis.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Fichier précis (optionnel, sinon tout le diff)" },
      staged: { type: "boolean", description: "true pour voir le diff des fichiers déjà stagés" },
    },
  },
};

export const gitLogTool: ToolDefinition = {
  name: "git_log",
  description: "Affiche l'historique des commits récents.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Nombre de commits à afficher (défaut 10)" },
    },
  },
};

export const gitCommitTool: ToolDefinition = {
  name: "git_commit",
  description: "Crée un commit avec les fichiers actuellement stagés (git add -A puis commit).",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message de commit" },
    },
    required: ["message"],
  },
};

export const gitBranchTool: ToolDefinition = {
  name: "git_branch",
  description: "Liste les branches, ou en crée/bascule une nouvelle si create_or_switch est fourni.",
  parameters: {
    type: "object",
    properties: {
      create_or_switch: { type: "string", description: "Nom de branche à créer/basculer (optionnel)" },
    },
  },
};

export function buildGitCommand(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "git_status":
      return "git status --short --branch";

    case "git_diff": {
      const a = args as { path?: string; staged?: boolean };
      const staged = a.staged ? "--staged" : "";
      const path = a.path ? ` -- "${a.path.replace(/"/g, '\\"')}"` : "";
      return `git diff ${staged}${path}`.trim();
    }

    case "git_log": {
      const a = args as { limit?: number };
      const limit = Math.max(1, Math.min(a.limit ?? 10, 50));
      return `git log --oneline -n ${limit}`;
    }

    case "git_commit": {
      const a = args as { message: string };
      const safeMessage = a.message.replace(/"/g, '\\"');
      return `git add -A && git commit -m "${safeMessage}"`;
    }

    case "git_branch": {
      const a = args as { create_or_switch?: string };
      if (a.create_or_switch) {
        const safeName = a.create_or_switch.replace(/[^a-zA-Z0-9._/-]/g, "");
        return `git checkout -b "${safeName}" 2>/dev/null || git checkout "${safeName}"`;
      }
      return "git branch --list";
    }

    default:
      throw new Error(`Commande git inconnue pour l'outil "${name}"`);
  }
}

export const gitRollbackTool: ToolDefinition = {
  name: "git_rollback",
  description:
    "Liste les snapshots automatiques du projet, ou restaure le working tree à l'état " +
    "d'un snapshot précis (action destructive sur les modifications non commitées). " +
    "Un snapshot est créé automatiquement avant chaque write_file et chaque commande DANGEROUS.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "'list' ou 'restore'", enum: ["list", "restore"] },
      snapshot_id: {
        type: "number",
        description: "Id du snapshot à restaurer (requis si action='restore', voir 'list')",
      },
    },
    required: ["action"],
  },
};

// Note : git_rollback n'a PAS d'entrée dans buildGitCommand — sa logique
// (lookup DB + git read-tree) est gérée directement dans tools/index.ts,
// car elle ne se réduit pas à une simple commande shell classifiable.

export const GIT_TOOLS: ToolDefinition[] = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitBranchTool,
  gitRollbackTool,
];

export const GIT_TOOL_NAMES = new Set(GIT_TOOLS.map((t) => t.name));
export const GIT_SHELL_TOOL_NAMES = new Set(
  GIT_TOOLS.filter((t) => t.name !== "git_rollback").map((t) => t.name)
);
