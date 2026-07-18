import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ParticipantId, SessionId, TableState } from "@llm-table/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.LLM_TABLE_DATA_DIR ?? path.resolve(__dirname, "../data");
const dbPath = path.join(dataDir, "llm-table.sqlite");

export interface PersistedSessionRow {
  sessionId: SessionId;
  state: TableState;
  apiKey: string;
  waitingForHuman: ParticipantId | null;
  updatedAt: string;
}

mkdirSync(dataDir, { recursive: true });

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      state_json TEXT NOT NULL,
      api_key TEXT NOT NULL,
      waiting_for_human TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

let db = openDatabase();

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin — only used for short SQLite busy retries
  }
}

function withRetry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return operation();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("database is locked") && !message.includes("SQLITE_BUSY")) {
        throw err;
      }
      // Brief backoff; common during tsx watch restarts
      sleepSync(50 * (attempt + 1));
    }
  }
  throw lastError;
}

console.log(`Session database: ${dbPath}`);

function parseRow(row: {
  session_id: string;
  state_json: string;
  api_key: string;
  waiting_for_human: string | null;
  updated_at: string;
}): PersistedSessionRow {
  const state = JSON.parse(row.state_json) as TableState;
  return {
    sessionId: row.session_id,
    state,
    apiKey: row.api_key,
    waitingForHuman: row.waiting_for_human,
    updatedAt: row.updated_at,
  };
}

export function upsertSession(params: {
  sessionId: SessionId;
  state: TableState;
  apiKey: string;
  waitingForHuman: ParticipantId | null;
}): void {
  const updatedAt = new Date().toISOString();
  withRetry(() => {
    db.prepare(
      `
      INSERT INTO sessions (session_id, state_json, api_key, waiting_for_human, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        state_json = excluded.state_json,
        api_key = excluded.api_key,
        waiting_for_human = excluded.waiting_for_human,
        updated_at = excluded.updated_at
      `,
    ).run(
      params.sessionId,
      JSON.stringify(params.state),
      params.apiKey,
      params.waitingForHuman,
      updatedAt,
    );
  });
}

export function loadAllSessions(): PersistedSessionRow[] {
  const rows = withRetry(
    () =>
      db
        .prepare(
          `
          SELECT session_id, state_json, api_key, waiting_for_human, updated_at
          FROM sessions
          ORDER BY updated_at ASC
          `,
        )
        .all() as Array<{
        session_id: string;
        state_json: string;
        api_key: string;
        waiting_for_human: string | null;
        updated_at: string;
      }>,
  );

  return rows.map(parseRow);
}

export function loadSession(sessionId: SessionId): PersistedSessionRow | null {
  const row = withRetry(
    () =>
      db
        .prepare(
          `
          SELECT session_id, state_json, api_key, waiting_for_human, updated_at
          FROM sessions
          WHERE session_id = ?
          `,
        )
        .get(sessionId) as
        | {
            session_id: string;
            state_json: string;
            api_key: string;
            waiting_for_human: string | null;
            updated_at: string;
          }
        | undefined,
  );

  return row ? parseRow(row) : null;
}

export function deleteSession(sessionId: SessionId): void {
  withRetry(() => {
    db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
  });
}

export function closeDatabase(): void {
  try {
    db.close();
  } catch {
    // already closed
  }
}

function reopenDatabase(): void {
  closeDatabase();
  db = openDatabase();
}

process.on("exit", () => {
  closeDatabase();
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    closeDatabase();
    process.exit(0);
  });
}

// If the previous watch process left a lock, reopen once after a short delay.
try {
  db.prepare("SELECT 1").get();
} catch {
  reopenDatabase();
}
