import { getDb } from "./db";

export interface SnapshotRecord {
  id: number;
  project_path: string;
  session_id: string | null;
  commit_hash: string;
  label: string;
  trigger: string;
  created_at: number;
}

/**
 * Enregistre un snapshot déjà créé côté Git (voir tools/snapshots.ts pour
 * la partie plumbing). Cette table sert uniquement d'index humainement
 * lisible au-dessus des commits "dangling" — la vérité reste dans .git.
 */
export async function recordSnapshot(params: {
  projectPath: string;
  sessionId?: string | null;
  commitHash: string;
  label: string;
  trigger: string;
}): Promise<number> {
  const db = await getDb();
  const result = db.run(
    `INSERT INTO snapshots (project_path, session_id, commit_hash, label, trigger, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      params.projectPath,
      params.sessionId ?? null,
      params.commitHash,
      params.label,
      params.trigger,
      Date.now(),
    ]
  );
  return Number(result.lastInsertRowid);
}

export async function listSnapshots(
  projectPath: string,
  limit = 20
): Promise<SnapshotRecord[]> {
  const db = await getDb();
  return db
    .query(
      `SELECT * FROM snapshots WHERE project_path = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(projectPath, limit) as SnapshotRecord[];
}

export async function getSnapshot(
  projectPath: string,
  id: number
): Promise<SnapshotRecord | null> {
  const db = await getDb();
  const row = db
    .query(`SELECT * FROM snapshots WHERE project_path = ? AND id = ?`)
    .get(projectPath, id) as SnapshotRecord | undefined;
  return row ?? null;
}

/** Le snapshot le plus récent (utilisé par `deku rollback` sans argument). */
export async function getLatestSnapshot(
  projectPath: string
): Promise<SnapshotRecord | null> {
  const db = await getDb();
  const row = db
    .query(
      `SELECT * FROM snapshots WHERE project_path = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(projectPath) as SnapshotRecord | undefined;
  return row ?? null;
}
