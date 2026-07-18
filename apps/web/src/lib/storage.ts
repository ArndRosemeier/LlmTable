import type { PersonaDraft } from "@llm-table/shared";

const DB_NAME = "llm-table";
const DB_VERSION = 2;
const SETTINGS_STORE = "settings";
const LOBBY_STORE = "lobby";

const KEY_API = "openrouter.apiKey";
const KEY_COORDINATOR_MODEL = "openrouter.coordinatorModel";
const KEY_IMAGE_MODEL = "openrouter.imageModel";
const KEY_LOBBY_DRAFT = "draft";
const KEY_ACTIVE_SESSION = "activeSession";

export interface LobbyDraft {
  personas: PersonaDraft[];
  /** Persona ids invited to the next table. */
  invitedIds?: string[];
  joinAsHuman: boolean;
  humanName: string;
  moduleId?: string;
}

export interface ActiveSessionRef {
  sessionId: string;
  localParticipantId: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open IndexedDB"));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE);
      }
      if (!db.objectStoreNames.contains(LOBBY_STORE)) {
        db.createObjectStore(LOBBY_STORE);
      }
    };
  });
}

async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => {
        reject(request.error ?? new Error(`Failed to read ${storeName}/${key}`));
      };

      request.onsuccess = () => {
        resolve(request.result as T | undefined);
      };
    });
  } finally {
    db.close();
  }
}

async function idbPut(storeName: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.put(value, key);

      request.onerror = () => {
        reject(request.error ?? new Error(`Failed to write ${storeName}/${key}`));
      };

      tx.oncomplete = () => {
        resolve();
      };

      tx.onerror = () => {
        reject(tx.error ?? new Error(`Failed to commit ${storeName}/${key}`));
      };
    });
  } finally {
    db.close();
  }
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.delete(key);

      request.onerror = () => {
        reject(request.error ?? new Error(`Failed to delete ${storeName}/${key}`));
      };

      tx.oncomplete = () => {
        resolve();
      };

      tx.onerror = () => {
        reject(tx.error ?? new Error(`Failed to commit delete ${storeName}/${key}`));
      };
    });
  } finally {
    db.close();
  }
}

async function getSetting(key: string): Promise<string> {
  const value = await idbGet<string>(SETTINGS_STORE, key);
  return typeof value === "string" ? value : "";
}

async function setSetting(key: string, value: string): Promise<void> {
  await idbPut(SETTINGS_STORE, key, value);
}

/** One-time copy from legacy localStorage keys into IndexedDB. */
async function migrateFromLocalStorage(): Promise<void> {
  const legacyApi = localStorage.getItem("llm-table.openrouter.apiKey");
  const legacyModel = localStorage.getItem("llm-table.openrouter.coordinatorModel");

  if (legacyApi !== null) {
    const existing = await getSetting(KEY_API);
    if (!existing) {
      await setSetting(KEY_API, legacyApi);
    }
    localStorage.removeItem("llm-table.openrouter.apiKey");
  }

  if (legacyModel !== null) {
    const existing = await getSetting(KEY_COORDINATOR_MODEL);
    if (!existing) {
      await setSetting(KEY_COORDINATOR_MODEL, legacyModel);
    }
    localStorage.removeItem("llm-table.openrouter.coordinatorModel");
  }
}

let migration: Promise<void> | null = null;

function ensureMigrated(): Promise<void> {
  if (!migration) {
    migration = migrateFromLocalStorage();
  }
  return migration;
}

export async function loadApiKey(): Promise<string> {
  await ensureMigrated();
  return getSetting(KEY_API);
}

export async function saveApiKey(apiKey: string): Promise<void> {
  await ensureMigrated();
  await setSetting(KEY_API, apiKey);
}

export async function loadCoordinatorModel(): Promise<string> {
  await ensureMigrated();
  return getSetting(KEY_COORDINATOR_MODEL);
}

export async function saveCoordinatorModel(model: string): Promise<void> {
  await ensureMigrated();
  await setSetting(KEY_COORDINATOR_MODEL, model);
}

export async function loadImageModel(): Promise<string> {
  await ensureMigrated();
  return getSetting(KEY_IMAGE_MODEL);
}

export async function saveImageModel(model: string): Promise<void> {
  await ensureMigrated();
  await setSetting(KEY_IMAGE_MODEL, model);
}

export async function loadLobbyDraft(): Promise<LobbyDraft | null> {
  await ensureMigrated();
  const draft = await idbGet<LobbyDraft>(LOBBY_STORE, KEY_LOBBY_DRAFT);
  if (!draft || !Array.isArray(draft.personas)) {
    return null;
  }
  return draft;
}

export async function saveLobbyDraft(draft: LobbyDraft): Promise<void> {
  await ensureMigrated();
  await idbPut(LOBBY_STORE, KEY_LOBBY_DRAFT, draft);
}

export async function loadActiveSession(): Promise<ActiveSessionRef | null> {
  await ensureMigrated();
  const ref = await idbGet<ActiveSessionRef>(LOBBY_STORE, KEY_ACTIVE_SESSION);
  if (!ref || typeof ref.sessionId !== "string") {
    return null;
  }
  return ref;
}

export async function saveActiveSession(ref: ActiveSessionRef): Promise<void> {
  await ensureMigrated();
  await idbPut(LOBBY_STORE, KEY_ACTIVE_SESSION, ref);
}

export async function clearActiveSession(): Promise<void> {
  await ensureMigrated();
  await idbDelete(LOBBY_STORE, KEY_ACTIVE_SESSION);
}
