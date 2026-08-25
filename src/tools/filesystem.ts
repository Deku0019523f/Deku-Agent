import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import type { ToolDefinition } from "../types";

/**
 * Toutes les opérations sont ancrées sur `cwd` (project root) et
 * refusent de sortir de cette zone — garde-fou de base tant que le
 * vrai système de permissions (V0.5) n'est pas construit.
 */
function assertInsideWorkspace(cwd: string, targetPath: string): string {
  const resolved = resolve(cwd, targetPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..")) {
    throw new Error(
      `Accès refusé : "${targetPath}" est en dehors du workspace (${cwd})`
    );
  }
  return resolved;
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Lit le contenu d'un fichier texte du projet.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Chemin relatif au projet" },
    },
    required: ["path"],
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Écrit (ou remplace) le contenu d'un fichier du projet.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Chemin relatif au projet" },
      content: { type: "string", description: "Contenu complet à écrire" },
    },
    required: ["path", "content"],
  },
};

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description: "Liste les fichiers et dossiers d'un répertoire du projet.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Chemin relatif, '.' pour la racine" },
    },
    required: ["path"],
  },
};

export async function executeReadFile(cwd: string, args: { path: string }) {
  const full = assertInsideWorkspace(cwd, args.path);
  return await readFile(full, "utf-8");
}

export async function executeWriteFile(
  cwd: string,
  args: { path: string; content: string }
) {
  const full = assertInsideWorkspace(cwd, args.path);
  await writeFile(full, args.content, "utf-8");
  return `Fichier écrit: ${args.path} (${args.content.length} caractères)`;
}

export async function executeListFiles(cwd: string, args: { path: string }) {
  const full = assertInsideWorkspace(cwd, args.path);
  const entries = await readdir(full, { withFileTypes: true });
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .join("\n");
}
