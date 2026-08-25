import type { PermissionLevel } from "../types";

const SAFE_PATTERNS = [
  /^ls\b/, /^pwd\b/, /^cat\b/, /^grep\b/, /^find\b/,
  /^git status\b/, /^git diff\b/, /^git log\b/, /^git branch --list\b/, /^npm test\b/,
  /^echo\b/, /^head\b/, /^tail\b/, /^wc\b/,
];

const DANGEROUS_PATTERNS = [
  /rm\s+-rf/, /^sudo\b/, /^chmod\b/, /^chown\b/, /mkfs/, /^dd\b/,
  /:\(\)\{.*\};:/, // fork bomb
];

/**
 * Détermine le niveau de permission d'une commande shell.
 * Par défaut (ni SAFE ni DANGEROUS) → CONFIRM.
 * Volontairement conservateur : dans le doute, on demande confirmation.
 */
export function classifyCommand(command: string): PermissionLevel {
  const trimmed = command.trim();

  if (DANGEROUS_PATTERNS.some((p) => p.test(trimmed))) return "DANGEROUS";
  if (SAFE_PATTERNS.some((p) => p.test(trimmed))) return "SAFE";
  return "CONFIRM";
}
