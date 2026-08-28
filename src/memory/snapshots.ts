import { readJson, writeJsonAtomic, SNAPSHOTS_FILE } from "./json-store";

export interface SnapshotRecord {
  id: number;
  project_path: string;
  session_id: string | null;
  commit_hash: string;
  label: string;
  trigger: string;
  created_at: number;
}

function loadSnapshots(): SnapshotRecord[] {
  return readJson<SnapshotRecord[]>(SNAPSHOTS_FILE, []);
}

/**
 * Enregistre un snapshot déjà créé côté Git (voir tools/snapshots.ts pour
 * la partie plumbing). Ce fichier sert uniquement d'index humainement
 * lisible au-dessus des commits "dangling" — la vérité reste dans .git.
 */
export async function recordSnapshot(params: {
  projectPath: string;
  sessionId?: string | null;
  commitHash: string;
  label: string;
  trigger: string;
}): Promise<number> {
  const snapshots = loadSnapshots();
  const id = snapshots.length > 0 ? Math.max(...snapshots.map((s) => s.id)) + 1 : 1;
  snapshots.push({
    id,
    project_path: params.projectPath,
    session_id: params.sessionId ?? null,
    commit_hash: params.commitHash,
    label: params.label,
    trigger: params.trigger,
    created_at: Date.now(),
  });
  writeJsonAtomic(SNAPSHOTS_FILE, snapshots);
  return id;
}

export async function listSnapshots(projectPath: string, limit = 20): Promise<SnapshotRecord[]> {
  return loadSnapshots()
    .filter((s) => s.project_path === projectPath)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

export async function getSnapshot(projectPath: string, id: number): Promise<SnapshotRecord | null> {
  const found = loadSnapshots().find((s) => s.project_path === projectPath && s.id === id);
  return found ?? null;
}

/** Le snapshot le plus récent (utilisé par `deku rollback` sans argument). */
export async function getLatestSnapshot(projectPath: string): Promise<SnapshotRecord | null> {
  const matches = loadSnapshots()
    .filter((s) => s.project_path === projectPath)
    .sort((a, b) => b.created_at - a.created_at);
  return matches[0] ?? null;
}
