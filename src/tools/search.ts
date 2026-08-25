import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition } from "../types";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  "__pycache__", ".venv", "venv", ".cache", "coverage",
]);

const MAX_RESULTS = 200;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB, on ignore les gros fichiers/binaires

export const grepSearchTool: ToolDefinition = {
  name: "grep_search",
  description:
    "Recherche un motif texte (regex) dans tous les fichiers du projet. " +
    "Retourne le chemin, le numéro de ligne et le contenu de chaque correspondance.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Motif à chercher (regex JS)" },
      path: { type: "string", description: "Sous-dossier où limiter la recherche (défaut: racine)" },
      file_extension: { type: "string", description: "Filtrer par extension, ex: 'ts' (optionnel)" },
    },
    required: ["pattern"],
  },
};

export const findFilesTool: ToolDefinition = {
  name: "find_files",
  description: "Trouve les fichiers dont le nom correspond à un motif (sous-chaîne ou regex).",
  parameters: {
    type: "object",
    properties: {
      name_pattern: { type: "string", description: "Sous-chaîne ou regex du nom de fichier" },
      path: { type: "string", description: "Sous-dossier où limiter la recherche (défaut: racine)" },
    },
    required: ["name_pattern"],
  },
};

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // dossier illisible/inexistant, on ignore
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
    if (out.length > 5000) return; // garde-fou sur les très gros projets
  }
}

export async function executeGrepSearch(
  cwd: string,
  args: { pattern: string; path?: string; file_extension?: string }
): Promise<string> {
  const startDir = join(cwd, args.path ?? ".");
  const files: string[] = [];
  await walk(cwd, startDir, files);

  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch {
    return `Erreur: regex invalide "${args.pattern}"`;
  }

  const matches: string[] = [];

  for (const file of files) {
    if (matches.length >= MAX_RESULTS) break;
    if (args.file_extension && !file.endsWith(`.${args.file_extension}`)) continue;

    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_SIZE) continue;

      const content = await readFile(file, "utf-8");
      const lines = content.split("\n");
      const relPath = relative(cwd, file);

      lines.forEach((line, i) => {
        if (matches.length >= MAX_RESULTS) return;
        if (regex.test(line)) {
          matches.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    } catch {
      continue; // fichier binaire ou illisible, on ignore
    }
  }

  if (matches.length === 0) return "Aucune correspondance trouvée.";
  const suffix = matches.length >= MAX_RESULTS ? `\n(résultats tronqués à ${MAX_RESULTS})` : "";
  return matches.join("\n") + suffix;
}

export async function executeFindFiles(
  cwd: string,
  args: { name_pattern: string; path?: string }
): Promise<string> {
  const startDir = join(cwd, args.path ?? ".");
  const files: string[] = [];
  await walk(cwd, startDir, files);

  let regex: RegExp;
  try {
    regex = new RegExp(args.name_pattern);
  } catch {
    // pas une regex valide -> traiter comme sous-chaîne littérale
    regex = new RegExp(args.name_pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }

  const matches = files
    .filter((f) => regex.test(f.split("/").pop() ?? ""))
    .map((f) => relative(cwd, f))
    .slice(0, MAX_RESULTS);

  return matches.length > 0 ? matches.join("\n") : "Aucun fichier trouvé.";
}
