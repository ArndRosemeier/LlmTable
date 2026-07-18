import {
  idbClear,
  idbGetAllEntries,
  idbPut,
  LOBBY_STORE,
  META_STORE,
  SEEDS_STORE,
  SESSIONS_STORE,
  SETTINGS_STORE,
} from "./db";

/** Bump when the on-disk backup shape gains new required fields. Old versions remain loadable. */
export const BACKUP_FORMAT_VERSION = 1;

export const BACKUP_KIND = "llm-table-backup" as const;

const STORE_NAMES = [
  SETTINGS_STORE,
  LOBBY_STORE,
  SEEDS_STORE,
  SESSIONS_STORE,
  META_STORE,
] as const;

type StoreName = (typeof STORE_NAMES)[number];

export type BackupStoreMap = Partial<Record<StoreName, Record<string, unknown>>>;

export interface LlmTableBackup {
  kind: typeof BACKUP_KIND;
  formatVersion: number;
  exportedAt: string;
  data: BackupStoreMap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entriesToMap(entries: Array<{ key: string; value: unknown }>): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const { key, value } of entries) {
    map[key] = value;
  }
  return map;
}

/** Snapshot every IndexedDB store into a portable backup object. */
export async function exportBackup(): Promise<LlmTableBackup> {
  const data: BackupStoreMap = {};
  for (const storeName of STORE_NAMES) {
    const entries = await idbGetAllEntries(storeName);
    data[storeName] = entriesToMap(entries);
  }

  return {
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/**
 * Parse and normalize a backup from any older formatVersion.
 * Newer app versions must accept older saves; unknown stores/keys are ignored.
 */
export function parseBackup(raw: unknown): LlmTableBackup {
  if (!isRecord(raw)) {
    throw new Error("Backup file is not a JSON object");
  }

  if (raw.kind !== BACKUP_KIND) {
    throw new Error(`Unrecognized backup kind (expected "${BACKUP_KIND}")`);
  }

  if (typeof raw.formatVersion !== "number" || !Number.isFinite(raw.formatVersion)) {
    throw new Error("Backup is missing a numeric formatVersion");
  }

  if (raw.formatVersion < 1) {
    throw new Error(`Unsupported backup formatVersion ${raw.formatVersion}`);
  }

  // Future backups from newer apps: still import known stores; do not hard-fail.
  if (!isRecord(raw.data)) {
    throw new Error("Backup is missing a data object");
  }

  const data: BackupStoreMap = {};
  for (const storeName of STORE_NAMES) {
    const storeValue = raw.data[storeName];
    if (storeValue === undefined) {
      continue;
    }
    if (!isRecord(storeValue)) {
      throw new Error(`Backup store "${storeName}" must be an object map`);
    }
    data[storeName] = storeValue;
  }

  return {
    kind: BACKUP_KIND,
    formatVersion: raw.formatVersion,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date(0).toISOString(),
    data,
  };
}

function normalizeSettingValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeSessionEntry(key: string, value: unknown): unknown | null {
  if (!isRecord(value)) {
    return null;
  }
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : key;
  if (!sessionId || !isRecord(value.state)) {
    return null;
  }
  return {
    ...value,
    sessionId,
    humanParticipantId:
      typeof value.humanParticipantId === "string" || value.humanParticipantId === null
        ? value.humanParticipantId
        : null,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  };
}

/**
 * Replace local IndexedDB contents with a backup.
 * Missing stores in older backups are cleared (empty), so import is a full replace.
 */
export async function importBackup(backup: LlmTableBackup): Promise<void> {
  for (const storeName of STORE_NAMES) {
    await idbClear(storeName);
    const map = backup.data[storeName];
    if (!map) {
      continue;
    }

    for (const [key, value] of Object.entries(map)) {
      if (storeName === SETTINGS_STORE) {
        const text = normalizeSettingValue(value);
        if (text === null) {
          continue;
        }
        await idbPut(storeName, key, text);
        continue;
      }

      if (storeName === SESSIONS_STORE) {
        const session = normalizeSessionEntry(key, value);
        if (session === null) {
          continue;
        }
        await idbPut(storeName, key, session);
        continue;
      }

      if (storeName === META_STORE && key === "activeSessionId") {
        if (typeof value === "string" && value.trim()) {
          await idbPut(storeName, key, value.trim());
        }
        continue;
      }

      await idbPut(storeName, key, value);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export class BackupCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "BackupCancelledError";
  }
}

function supportsSavePicker(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

function supportsOpenPicker(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

function suggestedBackupFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `llm-table-backup-${stamp}.json`;
}

async function writeBlobWithSavePicker(blob: Blob, suggestedName: string): Promise<void> {
  const picker = window.showSaveFilePicker;
  if (!picker) {
    throw new Error("File System Access save picker is unavailable");
  }
  const handle = await picker({
    suggestedName,
    types: [
      {
        description: "LlmTable backup",
        accept: { "application/json": [".json"] },
      },
    ],
  });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readTextWithOpenPicker(): Promise<string> {
  const picker = window.showOpenFilePicker;
  if (!picker) {
    throw new Error("File System Access open picker is unavailable");
  }
  const [handle] = await picker({
    multiple: false,
    types: [
      {
        description: "LlmTable backup",
        accept: { "application/json": [".json"] },
      },
    ],
  });
  const file = await handle.getFile();
  return file.text();
}

function readTextWithFileInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";

    const cleanup = (): void => {
      input.remove();
    };

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        reject(new BackupCancelledError());
        return;
      }
      void file.text().then(resolve, reject);
    });

    // Some browsers fire focus without change when the dialog is cancelled.
    window.addEventListener(
      "focus",
      () => {
        window.setTimeout(() => {
          if (!input.isConnected) {
            return;
          }
          if (!input.files?.length) {
            cleanup();
            reject(new BackupCancelledError());
          }
        }, 400);
      },
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}

/** Export IndexedDB → JSON file (File System Access picker when available). */
export async function saveBackupToFile(): Promise<void> {
  const backup = await exportBackup();
  const json = `${JSON.stringify(backup, null, 2)}\n`;
  const blob = new Blob([json], { type: "application/json" });
  const name = suggestedBackupFilename();

  try {
    if (supportsSavePicker()) {
      await writeBlobWithSavePicker(blob, name);
      return;
    }
    downloadBlob(blob, name);
  } catch (err) {
    if (isAbortError(err)) {
      throw new BackupCancelledError();
    }
    throw err;
  }
}

/** Pick a backup file and replace all local IndexedDB data. */
export async function loadBackupFromFile(): Promise<void> {
  let text: string;
  try {
    text = supportsOpenPicker() ? await readTextWithOpenPicker() : await readTextWithFileInput();
  } catch (err) {
    if (isAbortError(err) || err instanceof BackupCancelledError) {
      throw new BackupCancelledError();
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Backup file is not valid JSON");
  }

  const backup = parseBackup(parsed);
  await importBackup(backup);
}
