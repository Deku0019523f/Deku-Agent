import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Stockage global en fichiers JSON plats (~/.deku-agent/store/) —
 * remplace bun:sqlite (Bun n'est pas supporté sur Android/Termux : le
 * binaire officiel n'est même pas compilé en PIE, requis par le noyau
 * Android). Aucune dépendance native, fonctionne partout où Node tourne.
 */
export const STORE_DIR = join(homedir(), ".deku-agent", "store");
export const SESSIONS_FILE = join(STORE_DIR, "sessions.json");
export const MESSAGES_DIR = join(STORE_DIR, "messages");
export const PROJECT_MEMORY_FILE = join(STORE_DIR, "project-memory.json");
export const SNAPSHOTS_FILE = join(STORE_DIR, "snapshots.json");

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    // Fichier corrompu/tronqué (coupure d'alimentation, process tué en
    // pleine écriture...) : on repart d'un état vide plutôt que de
    // planter l'agent — la perte porte sur l'historique, jamais sur le
    // code du projet lui-même.
    return fallback;
  }
}

/**
 * Écrit via un fichier temporaire puis rename() — atomique sur POSIX,
 * donc jamais de fichier à moitié écrit visible même si le process est
 * tué en plein milieu (cas réaliste sur mobile : batterie, kill Termux).
 */
export function writeJsonAtomic<T>(path: string, data: T): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, path);
}
