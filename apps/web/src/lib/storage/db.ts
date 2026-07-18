const DB_NAME = "llm-table";
/** Bumped for clean client-only schema (sessions + meta stores). */
const DB_VERSION = 4;

export const SETTINGS_STORE = "settings";
export const LOBBY_STORE = "lobby";
export const SEEDS_STORE = "adventureSeeds";
export const SESSIONS_STORE = "sessions";
export const META_STORE = "meta";

export function openDb(): Promise<IDBDatabase> {
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
      for (const name of [
        SETTINGS_STORE,
        LOBBY_STORE,
        SEEDS_STORE,
        SESSIONS_STORE,
        META_STORE,
      ]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
  });
}

export async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
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

export async function idbPut(storeName: string, key: string, value: unknown): Promise<void> {
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

export async function idbDelete(storeName: string, key: string): Promise<void> {
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

export async function idbGetAllKeys(storeName: string): Promise<IDBValidKey[]> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const request = store.getAllKeys();

      request.onerror = () => {
        reject(request.error ?? new Error(`Failed to list keys in ${storeName}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  } finally {
    db.close();
  }
}

export async function idbGetAllEntries(
  storeName: string,
): Promise<Array<{ key: string; value: unknown }>> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const request = store.openCursor();
      const entries: Array<{ key: string; value: unknown }> = [];

      request.onerror = () => {
        reject(request.error ?? new Error(`Failed to read entries in ${storeName}`));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(entries);
          return;
        }
        if (typeof cursor.key === "string") {
          entries.push({ key: cursor.key, value: cursor.value });
        }
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
}

export async function idbClear(storeName: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.clear();

      request.onerror = () => {
        reject(request.error ?? new Error(`Failed to clear ${storeName}`));
      };

      tx.oncomplete = () => {
        resolve();
      };

      tx.onerror = () => {
        reject(tx.error ?? new Error(`Failed to commit clear ${storeName}`));
      };
    });
  } finally {
    db.close();
  }
}
