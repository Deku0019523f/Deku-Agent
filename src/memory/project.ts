import { getDb } from "./db";

/**
 * Informations persistantes SUR le projet, indépendantes des sessions :
 * architecture, conventions de code, commandes utiles, préférences,
 * décisions importantes prises pendant les sessions précédentes.
 * L'agent peut y écrire lui-même via un futur outil `remember` (V0.6+).
 */
export async function setProjectMemory(
  projectPath: string,
  key: string,
  value: string
): Promise<void> {
  const db = await getDb();
  db.run(
    `INSERT INTO project_memory (project_path, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_path, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [projectPath, key, value, Date.now()]
  );
}

export async function getProjectMemory(
  projectPath: string
): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = db
    .query(`SELECT key, value FROM project_memory WHERE project_path = ?`)
    .all(projectPath) as { key: string; value: string }[];

  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Résumé compact pour injection dans le prompt système. */
export function formatProjectMemory(memory: Record<string, string>): string | null {
  const entries = Object.entries(memory);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
}
