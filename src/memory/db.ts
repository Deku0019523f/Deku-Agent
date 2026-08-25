import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * Base globale (~/.deku-agent/deku.db), pas une base par projet —
 * les tables séparent les données par project_path. bun:sqlite est
 * intégré au runtime Bun : aucune compilation native (contrairement
 * à better-sqlite3, qui avait posé problème sur Render pour DarkDeku-Bot).
 */
const DB_PATH = join(homedir(), ".deku-agent", "deku.db");

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;

  await mkdir(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls_json TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS project_memory (
      project_path TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_path, key)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  `);

  return db;
}
