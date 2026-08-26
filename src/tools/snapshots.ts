import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "./terminal";
import {
  recordSnapshot,
  listSnapshots,
  getSnapshot,
  getLatestSnapshot,
  type SnapshotRecord,
} from "../memory/snapshots";

/**
 * Snapshots "dangling" : on construit un commit Git qui représente l'état
 * courant du répertoire de travail (via un index temporaire, pour ne PAS
 * toucher au staging réel de l'utilisateur), puis on l'ancre sous
 * refs/deku-agent/snapshots/<n> pour éviter que `git gc` ne le supprime.
 * Rien n'apparaît dans `git log`, `git branch` ou le HEAD courant.
 */

let snapshotCounter = 0;

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runCommand(cwd, "git rev-parse --is-inside-work-tree", 5_000);
  return result.exitCode === 0;
}

export async function createSnapshot(
  cwd: string,
  label: string,
  trigger: string,
  sessionId?: string | null
): Promise<{ id: number; hash: string } | null> {
  if (!(await isGitRepo(cwd))) return null;

  const tmpIndex = join(tmpdir(), `deku-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };

  try {
    // Peuple UNIQUEMENT l'index temporaire, jamais celui de l'utilisateur.
    const add = await runCommand(cwd, "git add -A", 30_000, env);
    if (add.exitCode !== 0) return null;

    const treeResult = await runCommand(cwd, "git write-tree", 10_000, env);
    if (treeResult.exitCode !== 0) return null;
    const tree = treeResult.stdout.trim();

    const parentResult = await runCommand(cwd, "git rev-parse HEAD", 5_000);
    const hasParent = parentResult.exitCode === 0;
    const safeLabel = label.replace(/"/g, '\\"');

    const commitCmd = hasParent
      ? `git commit-tree ${tree} -p ${parentResult.stdout.trim()} -m "${safeLabel}"`
      : `git commit-tree ${tree} -m "${safeLabel}"`;
    const commitResult = await runCommand(cwd, commitCmd, 10_000);
    if (commitResult.exitCode !== 0) return null;
    const hash = commitResult.stdout.trim();

    // Ancre le commit sous une ref dédiée pour le protéger du garbage collector.
    snapshotCounter += 1;
    const refName = `refs/deku-agent/snapshots/${Date.now()}-${snapshotCounter}`;
    await runCommand(cwd, `git update-ref ${refName} ${hash}`, 5_000);

    const id = await recordSnapshot({
      projectPath: cwd,
      sessionId,
      commitHash: hash,
      label,
      trigger,
    });

    return { id, hash };
  } catch {
    return null;
  } finally {
    await runCommand(cwd, `rm -f "${tmpIndex}"`, 5_000).catch(() => {});
  }
}

export async function listProjectSnapshots(cwd: string, limit = 20): Promise<SnapshotRecord[]> {
  return listSnapshots(cwd, limit);
}

/**
 * Restaure le working tree ET l'index sur l'état d'un snapshot.
 * Deux étapes nécessaires pour un rollback complet :
 *  1. `git read-tree --reset -u <hash>` : remet à jour l'index et tous les
 *     fichiers TRACKÉS (modifiés ou supprimés depuis le snapshot).
 *  2. `git clean -fd` : `read-tree` ne touche PAS les fichiers jamais
 *     ajoutés à l'index (untracked) — un fichier créé par l'agent après le
 *     snapshot survivrait sinon au rollback. `clean` respecte .gitignore,
 *     donc node_modules/etc. ne sont pas supprimés s'ils sont ignorés.
 * Destructif sur les modifications non commitées : toujours passer par
 * la confirmation DANGEROUS avant d'appeler cette fonction.
 */
export async function restoreSnapshot(
  cwd: string,
  snapshotId: number
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const record = await getSnapshot(cwd, snapshotId);
  if (!record) return { ok: false, error: `Snapshot #${snapshotId} introuvable pour ce projet.` };

  const readTree = await runCommand(cwd, `git read-tree --reset -u ${record.commit_hash}`, 30_000);
  if (readTree.exitCode !== 0) {
    return { ok: false, error: readTree.stderr || "Échec de la restauration du snapshot." };
  }

  const clean = await runCommand(cwd, "git clean -fd", 30_000);
  if (clean.exitCode !== 0) {
    return {
      ok: false,
      error: `Fichiers restaurés mais nettoyage des fichiers non trackés échoué: ${clean.stderr}`,
    };
  }

  return { ok: true, label: record.label };
}

export async function restoreLatestSnapshot(
  cwd: string
): Promise<{ ok: true; label: string; id: number } | { ok: false; error: string }> {
  const latest = await getLatestSnapshot(cwd);
  if (!latest) return { ok: false, error: "Aucun snapshot enregistré pour ce projet." };
  const result = await restoreSnapshot(cwd, latest.id);
  if (!result.ok) return result;
  return { ok: true, label: result.label, id: latest.id };
}

export function formatSnapshotList(snapshots: SnapshotRecord[]): string {
  if (snapshots.length === 0) return "Aucun snapshot enregistré pour ce projet.";
  return snapshots
    .map((s) => {
      const date = new Date(s.created_at).toLocaleString("fr-FR");
      return `#${s.id}  [${date}]  (${s.trigger}) ${s.label}  — ${s.commit_hash.slice(0, 8)}`;
    })
    .join("\n");
}
