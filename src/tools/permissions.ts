import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PermissionLevel } from "../types";

const DEFAULT_SAFE_PATTERNS = [
  /^ls\b/, /^pwd\b/, /^cat\b/, /^grep\b/, /^find\b/,
  /^git status\b/, /^git diff\b/, /^git log\b/, /^git branch --list\b/,
  /^git show\b/, /^git blame\b/, /^git remote -v\b/,
  /^npm test\b/, /^npm run test\b/, /^bun test\b/, /^bun run test\b/,
  /^echo\b/, /^head\b/, /^tail\b/, /^wc\b/, /^which\b/, /^env\b/,
];

/**
 * DANGEROUS = jamais exécuté sans confirmation explicite, MÊME en --auto.
 * Étendu (V0.5) au-delà des destructions filesystem brutes : perte
 * d'historique Git, exécution de code distant non vérifié, publication.
 */
const DEFAULT_DANGEROUS_PATTERNS = [
  // Filesystem destructif
  /rm\s+-rf/, /rm\s+-fr/, /^rm\b/, /^sudo\b/, /^chmod\b/, /^chown\b/,
  /mkfs/, /^dd\b/, /:\(\)\{.*\};:/, // fork bomb

  // Git destructif / perte d'historique / partage public
  /git\s+reset\s+--hard/, /git\s+clean\s+-[a-z]*f/, /git\s+push(\s+.*--force|.*-f\b)/,
  /git\s+checkout\s+\.\s*$/, /git\s+branch\s+-D\b/, /git\s+push\b/,

  // Exécution de code distant non vérifié
  /curl[^|]*\|\s*(sh|bash)/, /wget[^|]*\|\s*(sh|bash)/,

  // Publication / déploiement irréversible
  /npm\s+publish/, /^git\s+push\s+.*--tags/,
];

interface PermissionOverrides {
  safe?: string[];
  dangerous?: string[];
}

/**
 * Overrides par projet, chargés depuis <cwd>/.deku-agent/permissions.json
 * (fallback ~/.deku-agent/permissions.json si absent). Permet à
 * l'utilisateur d'élargir les listes par défaut sans toucher au code —
 * ex: autoriser "docker compose" en SAFE sur un projet précis.
 */
function loadOverrides(cwd: string): PermissionOverrides {
  const candidates = [
    join(cwd, ".deku-agent", "permissions.json"),
    join(homedir(), ".deku-agent", "permissions.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        // Fichier invalide : ignoré, on retombe sur les défauts.
      }
    }
  }
  return {};
}

function toRegexList(patterns: string[] | undefined): RegExp[] {
  if (!patterns) return [];
  return patterns
    .map((p) => {
      try {
        return new RegExp(p);
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

/**
 * Détermine le niveau de permission d'une commande shell.
 * Par défaut (ni SAFE ni DANGEROUS) → CONFIRM.
 * Volontairement conservateur : dans le doute, on demande confirmation.
 * DANGEROUS est prioritaire sur SAFE en cas de conflit (sécurité d'abord).
 */
export function classifyCommand(command: string, cwd = process.cwd()): PermissionLevel {
  const trimmed = command.trim();
  const overrides = loadOverrides(cwd);

  const dangerousPatterns = [...DEFAULT_DANGEROUS_PATTERNS, ...toRegexList(overrides.dangerous)];
  if (dangerousPatterns.some((p) => p.test(trimmed))) return "DANGEROUS";

  const safePatterns = [...DEFAULT_SAFE_PATTERNS, ...toRegexList(overrides.safe)];
  if (safePatterns.some((p) => p.test(trimmed))) return "SAFE";

  return "CONFIRM";
}

/**
 * Fichiers sensibles : même en --auto, une écriture dessus repasse par
 * confirmation. Couvre secrets, config Git interne, lockfiles (une
 * modification silencieuse peut casser les dépendances de tout le monde).
 */
const SENSITIVE_FILE_PATTERNS = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.git\//,
  /(^|\/)(package-lock\.json|bun\.lockb|yarn\.lock|pnpm-lock\.yaml)$/,
  /(^|\/)\.deku-agent\//,
];

export function isSensitivePath(relativePath: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((p) => p.test(relativePath));
}
