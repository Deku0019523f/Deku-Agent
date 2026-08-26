import type { ToolDefinition } from "../types";
import { runCommand } from "./terminal";

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

/**
 * Déduit owner/repo depuis `git remote get-url origin`. Supporte HTTPS
 * (https://github.com/owner/repo.git) et SSH (git@github.com:owner/repo.git),
 * avec ou sans suffixe .git — formats vérifiés contre le remote réel du
 * projet avant d'écrire ce parseur.
 */
export async function detectGithubRepo(cwd: string): Promise<GithubRepoRef | null> {
  const result = await runCommand(cwd, "git remote get-url origin", 5_000);
  if (result.exitCode !== 0) return null;

  const url = result.stdout.trim();
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * Résolution du token, par ordre de préférence :
 * 1. $GITHUB_TOKEN (standard, ce que l'utilisateur exporte dans son shell)
 * 2. `gh auth token` si GitHub CLI est installé et authentifié (lecture
 *    locale, pas d'appel réseau propre à cette étape)
 * Jamais lu depuis un fichier de config committable — le token ne doit
 * JAMAIS finir dans le repo ou dans .deku-agent/ versionné.
 */
export async function resolveGithubToken(cwd: string): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  const ghAuth = await runCommand(cwd, "gh auth token", 5_000);
  if (ghAuth.exitCode === 0 && ghAuth.stdout.trim()) return ghAuth.stdout.trim();

  return null;
}

async function githubRequest(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${json.message ?? text.slice(0, 200)}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// Définitions d'outils
// ============================================================

export const githubListIssuesTool: ToolDefinition = {
  name: "github_list_issues",
  description: "Liste les issues du repository GitHub distant (remote origin détecté automatiquement).",
  parameters: {
    type: "object",
    properties: {
      state: { type: "string", enum: ["open", "closed", "all"], description: "Défaut: open" },
      limit: { type: "number", description: "Nombre max de résultats (défaut 10, max 50)" },
    },
  },
};

export const githubCreateIssueTool: ToolDefinition = {
  name: "github_create_issue",
  description: "Crée une nouvelle issue sur le repository GitHub distant. Action publique, toujours confirmée.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string", description: "Description en Markdown (optionnel)" },
      labels: { type: "array", items: { type: "string" }, description: "Labels à appliquer (optionnel)" },
    },
    required: ["title"],
  },
};

export const githubCommentIssueTool: ToolDefinition = {
  name: "github_comment_issue",
  description: "Ajoute un commentaire sur une issue ou PR existante (même endpoint côté GitHub). Toujours confirmé.",
  parameters: {
    type: "object",
    properties: {
      issue_number: { type: "number" },
      body: { type: "string" },
    },
    required: ["issue_number", "body"],
  },
};

export const githubListPrsTool: ToolDefinition = {
  name: "github_list_prs",
  description: "Liste les pull requests du repository GitHub distant.",
  parameters: {
    type: "object",
    properties: {
      state: { type: "string", enum: ["open", "closed", "all"], description: "Défaut: open" },
      limit: { type: "number", description: "Nombre max de résultats (défaut 10, max 50)" },
    },
  },
};

export const githubGetPrTool: ToolDefinition = {
  name: "github_get_pr",
  description: "Détails d'une pull request : titre, état, branche, fichiers modifiés, +additions/-suppressions.",
  parameters: {
    type: "object",
    properties: { pr_number: { type: "number" } },
    required: ["pr_number"],
  },
};

export const githubCreatePrTool: ToolDefinition = {
  name: "github_create_pr",
  description:
    "Crée une pull request depuis une branche déjà poussée sur le remote vers la branche par défaut (ou 'base' donnée). " +
    "La branche 'head' doit déjà exister sur origin (git push au préalable). Action publique, toujours confirmée.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      head: { type: "string", description: "Branche source (déjà poussée sur origin)" },
      base: { type: "string", description: "Branche cible (défaut: branche par défaut du repo)" },
      body: { type: "string", description: "Description en Markdown (optionnel)" },
      draft: { type: "boolean", description: "Créer en brouillon (défaut false)" },
    },
    required: ["title", "head"],
  },
};

export const GITHUB_TOOLS: ToolDefinition[] = [
  githubListIssuesTool,
  githubCreateIssueTool,
  githubCommentIssueTool,
  githubListPrsTool,
  githubGetPrTool,
  githubCreatePrTool,
];

export const GITHUB_TOOL_NAMES = new Set(GITHUB_TOOLS.map((t) => t.name));

/**
 * Outils en écriture (créent du contenu public, visible par d'autres) —
 * toujours confirmés par l'utilisateur, quel que soit --auto. Même
 * logique que les commandes DANGEROUS et git_rollback restore : une
 * action irréversible-en-pratique (une issue publiée reste indexée même
 * fermée) ne doit jamais s'exécuter silencieusement.
 */
const GITHUB_WRITE_TOOLS = new Set(["github_create_issue", "github_comment_issue", "github_create_pr"]);

export function isGithubWriteTool(name: string): boolean {
  return GITHUB_WRITE_TOOLS.has(name);
}

function truncate(text: string, max = 3000): string {
  return text.length > max ? `${text.slice(0, max)}\n... (tronqué)` : text;
}

/**
 * Exécute un outil github_*. Résout repo + token à chaque appel (coût
 * négligeable : une commande git locale + éventuellement `gh auth token`,
 * pas d'appel réseau avant la requête elle-même).
 */
export async function executeGithubTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string
): Promise<string> {
  const repo = await detectGithubRepo(cwd);
  if (!repo) {
    throw new Error(
      "Impossible de déterminer le repository GitHub (remote 'origin' absent ou non-GitHub)."
    );
  }
  const token = await resolveGithubToken(cwd);
  if (!token) {
    throw new Error(
      "Aucun token GitHub disponible. Exporte GITHUB_TOKEN dans l'environnement, ou authentifie-toi via `gh auth login`."
    );
  }

  const base = `/repos/${repo.owner}/${repo.repo}`;

  switch (name) {
    case "github_list_issues": {
      const state = (args.state as string) ?? "open";
      const limit = Math.min((args.limit as number) ?? 10, 50);
      const issues = await githubRequest(token, "GET", `${base}/issues?state=${state}&per_page=${limit}`);
      const list = (issues as any[]).filter((i) => !i.pull_request); // l'API issues inclut aussi les PR
      if (list.length === 0) return `Aucune issue (${state}).`;
      return list
        .map((i) => `#${i.number} [${i.state}] ${i.title}${i.labels?.length ? ` (${i.labels.map((l: any) => l.name).join(", ")})` : ""}`)
        .join("\n");
    }

    case "github_create_issue": {
      const created = await githubRequest(token, "POST", `${base}/issues`, {
        title: args.title,
        body: args.body,
        labels: args.labels,
      });
      return `Issue créée: #${created.number} — ${created.html_url}`;
    }

    case "github_comment_issue": {
      const created = await githubRequest(
        token,
        "POST",
        `${base}/issues/${args.issue_number}/comments`,
        { body: args.body }
      );
      return `Commentaire ajouté sur #${args.issue_number} — ${created.html_url}`;
    }

    case "github_list_prs": {
      const state = (args.state as string) ?? "open";
      const limit = Math.min((args.limit as number) ?? 10, 50);
      const prs = await githubRequest(token, "GET", `${base}/pulls?state=${state}&per_page=${limit}`);
      if ((prs as any[]).length === 0) return `Aucune pull request (${state}).`;
      return (prs as any[])
        .map((pr) => `#${pr.number} [${pr.state}] ${pr.title} (${pr.head.ref} → ${pr.base.ref})`)
        .join("\n");
    }

    case "github_get_pr": {
      const pr = await githubRequest(token, "GET", `${base}/pulls/${args.pr_number}`);
      const files = await githubRequest(token, "GET", `${base}/pulls/${args.pr_number}/files?per_page=100`);
      const fileList = (files as any[])
        .map((f) => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
        .join("\n");
      return truncate(
        `#${pr.number} [${pr.state}${pr.draft ? ", draft" : ""}] ${pr.title}\n` +
          `${pr.head.ref} → ${pr.base.ref}\n` +
          `+${pr.additions}/-${pr.deletions}, ${pr.changed_files} fichier(s)\n` +
          (pr.body ? `\n${pr.body}\n` : "") +
          `\nFichiers modifiés:\n${fileList}`
      );
    }

    case "github_create_pr": {
      const created = await githubRequest(token, "POST", `${base}/pulls`, {
        title: args.title,
        head: args.head,
        base: args.base, // undefined -> GitHub utilise la branche par défaut du repo
        body: args.body,
        draft: args.draft ?? false,
      });
      return `Pull request créée: #${created.number} — ${created.html_url}`;
    }

    default:
      throw new Error(`Outil GitHub inconnu: ${name}`);
  }
}
