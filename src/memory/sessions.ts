import { getDb } from "./db";
import type { Message } from "../types";

export interface SessionRecord {
  id: string;
  project_path: string;
  objective: string;
  status: "running" | "completed" | "error" | "interrupted";
  started_at: number;
  ended_at: number | null;
}

export async function createSession(
  projectPath: string,
  objective: string
): Promise<string> {
  const db = await getDb();
  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.run(
    `INSERT INTO sessions (id, project_path, objective, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
    [id, projectPath, objective, Date.now()]
  );
  return id;
}

export async function endSession(
  sessionId: string,
  status: "completed" | "error" | "interrupted"
): Promise<void> {
  const db = await getDb();
  db.run(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`, [
    status,
    Date.now(),
    sessionId,
  ]);
}

export async function saveMessage(sessionId: string, message: Message): Promise<void> {
  const db = await getDb();
  db.run(
    `INSERT INTO messages (session_id, role, content, tool_calls_json, tool_call_id, tool_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      message.role,
      message.content,
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      message.tool_call_id ?? null,
      message.name ?? null,
      Date.now(),
    ]
  );
}

export async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const db = await getDb();
  const rows = db
    .query(`SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId) as any[];

  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    tool_calls: r.tool_calls_json ? JSON.parse(r.tool_calls_json) : undefined,
    tool_call_id: r.tool_call_id ?? undefined,
    name: r.tool_name ?? undefined,
  }));
}

/** Dernière session non terminée pour ce projet (pour --resume). */
export async function findResumableSession(
  projectPath: string
): Promise<SessionRecord | null> {
  const db = await getDb();
  const row = db
    .query(
      `SELECT * FROM sessions WHERE project_path = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`
    )
    .get(projectPath) as SessionRecord | undefined;
  return row ?? null;
}

export async function listSessions(
  projectPath: string,
  limit = 10
): Promise<SessionRecord[]> {
  const db = await getDb();
  return db
    .query(
      `SELECT * FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(projectPath, limit) as SessionRecord[];
}
