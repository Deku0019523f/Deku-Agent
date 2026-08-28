import { readJson, writeJsonAtomic, PROJECT_MEMORY_FILE } from "./json-store";

type ProjectMemoryStore = Record<string, Record<string, string>>; // { [projectPath]: { [key]: value } }

function loadStore(): ProjectMemoryStore {
  return readJson<ProjectMemoryStore>(PROJECT_MEMORY_FILE, {});
}

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
  const store = loadStore();
  store[projectPath] = { ...store[projectPath], [key]: value };
  writeJsonAtomic(PROJECT_MEMORY_FILE, store);
}

export async function getProjectMemory(projectPath: string): Promise<Record<string, string>> {
  return loadStore()[projectPath] ?? {};
}

/** Résumé compact pour injection dans le prompt système. */
export function formatProjectMemory(memory: Record<string, string>): string | null {
  const entries = Object.entries(memory);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
}
