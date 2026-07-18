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

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin — only used for short SQLite busy retries during watch restarts
  }
}

function isSqliteBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("database is locked") ||
    message.includes("SQLITE_BUSY") ||
    message.includes("SQLITE_LOCKED")
  );
}

function openDatabaseOnce(): DatabaseSync {
  const database = new DatabaseSync(dbPath, { timeout: 10_000 });
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 10000;");
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

/** Open SQLite with retries — common when tsx watch overlaps the previous process. */
function openDatabase(): DatabaseSync {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const database = openDatabaseOnce();
      database.prepare("SELECT 1").get();
      if (attempt > 0) {
        console.warn(`SQLite opened after ${attempt + 1} attempt(s)`);
      }
      return database;
    } catch (err) {
      lastError = err;
      if (!isSqliteBusy(err)) {
        throw err;
      }
      if (attempt === 0 || attempt % 5 === 4) {
        console.warn(
          `SQLite busy while opening (attempt ${attempt + 1}/40) — waiting for previous server…`,
        );
      }
      sleepSync(150 + attempt * 25);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to open SQLite database: ${String(lastError)}`);
}

let db = openDatabase();
let closed = false;

function withRetry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return operation();
    } catch (err) {
      lastError = err;
      if (!isSqliteBusy(err)) {
        throw err;
      }
      sleepSync(50 * (attempt + 1));
      if (attempt === 3 || attempt === 6) {
        try {
          reopenDatabase();
        } catch {
          // keep retrying with existing handle
        }
      }
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
  if (closed) {
    return;
  }
  closed = true;
  try {
    db.close();
  } catch {
    // already closed
  }
}

function reopenDatabase(): void {
  closeDatabase();
  closed = false;
  db = openDatabase();
}

// Best-effort close if the process exits without going through index shutdown.
process.once("exit", () => {
  closeDatabase();
});
