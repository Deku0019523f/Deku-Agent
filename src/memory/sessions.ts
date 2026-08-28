import { join } from "node:path";
import { readJson, writeJsonAtomic, SESSIONS_FILE, MESSAGES_DIR } from "./json-store";
import type { Message } from "../types";

export type SessionStatus = "running" | "completed" | "error" | "interrupted";

export interface SessionRecord {
  id: string;
  project_path: string;
  objective: string;
  status: SessionStatus;
  started_at: number;
  ended_at: number | null;
}

interface StoredMessage {
  role: Message["role"];
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
  thoughtSignature?: string;
  created_at: number;
}

function loadSessions(): SessionRecord[] {
  return readJson<SessionRecord[]>(SESSIONS_FILE, []);
}

function saveSessions(sessions: SessionRecord[]): void {
  writeJsonAtomic(SESSIONS_FILE, sessions);
}

function messagesPath(sessionId: string): string {
  return join(MESSAGES_DIR, `${sessionId}.json`);
}

/** Un fichier par session (messages/<id>.json) : append proportionnel à la
 *  taille de CETTE session, pas à l'historique global — pas de réécriture
 *  d'un gros fichier unique à chaque message. */
export async function createSession(projectPath: string, objective: string): Promise<string> {
  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessions = loadSessions();
  sessions.push({
    id,
    project_path: projectPath,
    objective,
    status: "running",
    started_at: Date.now(),
    ended_at: null,
  });
  saveSessions(sessions);
  return id;
}

export async function endSession(sessionId: string, status: Exclude<SessionStatus, "running">): Promise<void> {
  const sessions = loadSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    session.status = status;
    session.ended_at = Date.now();
    saveSessions(sessions);
  }
}

export async function saveMessage(sessionId: string, message: Message): Promise<void> {
  const path = messagesPath(sessionId);
  const messages = readJson<StoredMessage[]>(path, []);
  messages.push({
    role: message.role,
    content: message.content ?? null,
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
    name: message.name,
    thoughtSignature: message.thoughtSignature,
    created_at: Date.now(),
  });
  writeJsonAtomic(path, messages);
}

export async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const messages = readJson<StoredMessage[]>(messagesPath(sessionId), []);
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_calls: m.tool_calls as Message["tool_calls"],
    tool_call_id: m.tool_call_id,
    name: m.name,
    thoughtSignature: m.thoughtSignature,
  }));
}

/** La session "running" la plus récente pour ce projet, ou null. */
export async function findResumableSession(projectPath: string): Promise<SessionRecord | null> {
  const matches = loadSessions()
    .filter((s) => s.project_path === projectPath && s.status === "running")
    .sort((a, b) => b.started_at - a.started_at);
  return matches[0] ?? null;
}

export async function listSessions(projectPath: string, limit = 10): Promise<SessionRecord[]> {
  return loadSessions()
    .filter((s) => s.project_path === projectPath)
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, limit);
}
