import type { AdventureSeed, PersonaDraft, ParticipantId, SessionId, TableState } from "@llm-table/shared";
import {
  idbDelete,
  idbGet,
  idbGetAllKeys,
  idbPut,
  LOBBY_STORE,
  META_STORE,
  SEEDS_STORE,
  SESSIONS_STORE,
  SETTINGS_STORE,
} from "./db";

const KEY_API = "apiKey";
const KEY_COORDINATOR_MODEL = "coordinatorModel";
const KEY_IMAGE_MODEL = "imageModel";
const KEY_LOBBY_DRAFT = "draft";
const KEY_CUSTOM_SEEDS = "custom";
const KEY_ACTIVE_SESSION_ID = "activeSessionId";

export interface LobbyDraft {
  personas: PersonaDraft[];
  invitedIds?: string[];
  joinAsHuman: boolean;
  humanName: string;
  moduleId?: string;
  adventureSeedId?: string;
  gmPersonaId?: string;
  gmImagesEnabled?: boolean;
}

export interface StoredSession {
  sessionId: SessionId;
  state: TableState;
  humanParticipantId: ParticipantId | null;
  updatedAt: number;
}

async function getSetting(key: string): Promise<string> {
  const value = await idbGet<string>(SETTINGS_STORE, key);
  return typeof value === "string" ? value : "";
}

async function setSetting(key: string, value: string): Promise<void> {
  await idbPut(SETTINGS_STORE, key, value);
}

export async function loadApiKey(): Promise<string> {
  return getSetting(KEY_API);
}

export async function saveApiKey(apiKey: string): Promise<void> {
  await setSetting(KEY_API, apiKey);
}

export async function loadCoordinatorModel(): Promise<string> {
  return getSetting(KEY_COORDINATOR_MODEL);
}

export async function saveCoordinatorModel(model: string): Promise<void> {
  await setSetting(KEY_COORDINATOR_MODEL, model);
}

export async function loadImageModel(): Promise<string> {
  return getSetting(KEY_IMAGE_MODEL);
}

export async function saveImageModel(model: string): Promise<void> {
  await setSetting(KEY_IMAGE_MODEL, model);
}

export async function loadLobbyDraft(): Promise<LobbyDraft | null> {
  const draft = await idbGet<LobbyDraft>(LOBBY_STORE, KEY_LOBBY_DRAFT);
  if (!draft || !Array.isArray(draft.personas)) {
    return null;
  }
  return draft;
}

export async function saveLobbyDraft(draft: LobbyDraft): Promise<void> {
  await idbPut(LOBBY_STORE, KEY_LOBBY_DRAFT, draft);
}

export async function loadCustomAdventureSeeds(): Promise<AdventureSeed[]> {
  const seeds = await idbGet<AdventureSeed[]>(SEEDS_STORE, KEY_CUSTOM_SEEDS);
  if (!Array.isArray(seeds)) {
    return [];
  }
  return seeds.filter(
    (s) => s && typeof s === "object" && typeof s.id === "string" && typeof s.title === "string",
  );
}

export async function saveCustomAdventureSeeds(seeds: AdventureSeed[]): Promise<void> {
  await idbPut(SEEDS_STORE, KEY_CUSTOM_SEEDS, seeds);
}

export async function getActiveSessionId(): Promise<SessionId | null> {
  const id = await idbGet<string>(META_STORE, KEY_ACTIVE_SESSION_ID);
  return typeof id === "string" && id.trim() ? id : null;
}

export async function setActiveSessionId(sessionId: SessionId | null): Promise<void> {
  if (sessionId === null) {
    await idbDelete(META_STORE, KEY_ACTIVE_SESSION_ID);
    return;
  }
  await idbPut(META_STORE, KEY_ACTIVE_SESSION_ID, sessionId);
}

export async function getStoredSession(sessionId: SessionId): Promise<StoredSession | null> {
  const row = await idbGet<StoredSession>(SESSIONS_STORE, sessionId);
  if (!row || typeof row !== "object" || row.sessionId !== sessionId || !row.state) {
    return null;
  }
  return row;
}

export async function putStoredSession(session: StoredSession): Promise<void> {
  await idbPut(SESSIONS_STORE, session.sessionId, {
    ...session,
    updatedAt: Date.now(),
  });
}

export async function deleteStoredSession(sessionId: SessionId): Promise<void> {
  await idbDelete(SESSIONS_STORE, sessionId);
}

export async function listStoredSessionIds(): Promise<SessionId[]> {
  const keys = await idbGetAllKeys(SESSIONS_STORE);
  return keys.filter((k): k is string => typeof k === "string");
}

export {
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
  BackupCancelledError,
  exportBackup,
  importBackup,
  loadBackupFromFile,
  parseBackup,
  saveBackupToFile,
  type LlmTableBackup,
} from "./backup";
