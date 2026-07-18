import type {
  ClientAction,
  CreateSessionRequest,
  Participant,
  ParticipantId,
  SessionId,
  TableState,
} from "@llm-table/shared";
import { buildInitialRpgState, resolveAdventureSeed } from "@llm-table/rpg";
import type { WebSocket } from "ws";
import { loadAllSessions, upsertSession } from "./db.js";
import { getModule } from "./registry.js";

export interface SessionSecrets {
  apiKey: string;
}

export interface RpgPrefetchSlot {
  generation: number;
  speakerId: ParticipantId;
  promise: Promise<ClientAction>;
  action: ClientAction | null;
  error: string | null;
}

export interface SessionRecord {
  state: TableState;
  secrets: SessionSecrets;
  connections: Map<string, WebSocket>;
  /** participantId -> connectionId */
  participantConnections: Map<ParticipantId, string>;
  turnGeneration: number;
  waitingForHuman: ParticipantId | null;
  /** RPG: prefetched next LLM action waiting for manual advance. */
  rpgPrefetch: RpgPrefetchSlot | null;
  /** Prevents double-apply when Next is pressed twice. */
  rpgAdvanceLock: boolean;
}

const sessions = new Map<SessionId, SessionRecord>();

export function persistSession(session: SessionRecord): void {
  // Never persist live connection bindings — those are runtime-only.
  const stateForDisk: TableState = {
    ...session.state,
    participants: session.state.participants.map((p) => {
      const { connectionId: _connectionId, ...rest } = p;
      return rest;
    }),
  };

  upsertSession({
    sessionId: session.state.sessionId,
    state: stateForDisk,
    apiKey: session.secrets.apiKey,
    waitingForHuman: session.waitingForHuman,
  });
}

export function getSession(sessionId: SessionId): SessionRecord | undefined {
  return sessions.get(sessionId);
}

export function requireSession(sessionId: SessionId): SessionRecord {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return session;
}

export function publicState(
  session: SessionRecord,
  viewerId: ParticipantId | null = null,
): TableState {
  const mod = getModule(session.state.moduleId);
  const base: TableState = {
    ...session.state,
    // never leak live connection bindings as authority — already on participants
  };
  return mod.redactState ? mod.redactState(base, viewerId) : base;
}

function restoreStateAfterRestart(state: TableState): TableState {
  const clearedParticipants = state.participants.map((p) => {
    const { connectionId: _connectionId, ...rest } = p;
    return rest;
  });

  if (state.phase === "running") {
    return {
      ...state,
      participants: clearedParticipants,
      phase: "paused",
      activeSpeakerId: null,
      statusMessage: "Server restarted — resume to continue",
      error: null,
    };
  }

  return {
    ...state,
    participants: clearedParticipants,
  };
}

export function loadSessionsFromDisk(): number {
  const rows = loadAllSessions();
  for (const row of rows) {
    const wasRunning = row.state.phase === "running";
    const state = restoreStateAfterRestart(row.state);
    const session: SessionRecord = {
      state,
      secrets: { apiKey: row.apiKey },
      connections: new Map(),
      participantConnections: new Map(),
      turnGeneration: 0,
      waitingForHuman: null,
      rpgPrefetch: null,
      rpgAdvanceLock: false,
    };
    sessions.set(row.sessionId, session);
    // Only rewrite if we had to pause a previously running table
    if (wasRunning) {
      persistSession(session);
    }
  }
  return rows.length;
}

export function createSession(request: CreateSessionRequest): {
  session: SessionRecord;
  localParticipantId: ParticipantId | null;
} {
  if (!request.apiKey.trim()) {
    throw new Error("OpenRouter API key is required");
  }
  if (!request.coordinatorModel.trim()) {
    throw new Error("Coordinator model is required");
  }
  if (request.personas.length < 2) {
    throw new Error("At least 2 LLM personas are required");
  }

  for (const persona of request.personas) {
    if (!persona.displayName.trim()) {
      throw new Error("Each persona needs a display name");
    }
    if (!persona.systemPrompt.trim()) {
      throw new Error(`Persona "${persona.displayName}" needs a definition`);
    }
    if (!persona.model.trim()) {
      throw new Error(`Persona "${persona.displayName}" needs a model`);
    }
  }

  getModule(request.moduleId);

  const sessionId = crypto.randomUUID();
  const isRpg = request.moduleId === "rpg";
  const adventureSeed = isRpg
    ? resolveAdventureSeed({
        adventureSeedId: request.adventureSeedId,
        adventureSeed: request.adventureSeed,
      })
    : null;

  const gmPersonaId = isRpg ? request.gmPersonaId?.trim() : undefined;
  if (isRpg) {
    if (!gmPersonaId) {
      throw new Error("RPG table requires a GM persona");
    }
    const gmDraft = request.personas.find((p) => p.id.trim() === gmPersonaId);
    if (!gmDraft) {
      throw new Error("GM persona must be one of the invited personas");
    }
  }

  const participants: Participant[] = request.personas.map((p, index) => {
    const id = p.id.trim() || crypto.randomUUID();
    const isGm = isRpg && id === gmPersonaId;
    return {
      id,
      kind: "llm" as const,
      displayName: p.displayName.trim(),
      persona: {
        systemPrompt: p.systemPrompt.trim(),
        model: p.model.trim(),
        ...(p.portraitDataUrl?.trim()
          ? { portraitDataUrl: p.portraitDataUrl.trim() }
          : {}),
      },
      seatIndex: index,
      ...(isRpg ? { tableRole: (isGm ? "gm" : "pc") as "gm" | "pc" } : {}),
    };
  });

  let localParticipantId: ParticipantId | null = null;
  const humanName = request.humanName?.trim();
  if (humanName) {
    localParticipantId = crypto.randomUUID();
    participants.push({
      id: localParticipantId,
      kind: "human",
      displayName: humanName,
      seatIndex: participants.length,
      ...(isRpg ? { tableRole: "pc" as const } : {}),
    });
  }

  if (isRpg) {
    const pcs = participants.filter((p) => p.tableRole !== "gm");
    if (pcs.length < 1) {
      throw new Error("RPG table needs at least one PC besides the GM");
    }
  }

  const moduleState = isRpg
    ? buildInitialRpgState(participants, adventureSeed!)
    : {};

  const state: TableState = {
    sessionId,
    moduleId: request.moduleId,
    participants,
    messages: [],
    activeSpeakerId: null,
    phase: "lobby",
    moduleState,
    coordinatorModel: request.coordinatorModel.trim(),
    ...(request.imageModel?.trim() ? { imageModel: request.imageModel.trim() } : {}),
    error: null,
    statusMessage: isRpg
      ? `${adventureSeed!.title} — lobby`
      : "Lobby — start when ready",
  };

  const session: SessionRecord = {
    state,
    secrets: { apiKey: request.apiKey.trim() },
    connections: new Map(),
    participantConnections: new Map(),
    turnGeneration: 0,
    waitingForHuman: null,
    rpgPrefetch: null,
    rpgAdvanceLock: false,
  };

  sessions.set(sessionId, session);
  persistSession(session);
  return { session, localParticipantId };
}

export function attachConnection(
  session: SessionRecord,
  connectionId: string,
  ws: WebSocket,
  participantId: ParticipantId | null,
): ParticipantId | null {
  session.connections.set(connectionId, ws);

  if (participantId) {
    const participant = session.state.participants.find((p) => p.id === participantId);
    if (!participant) {
      throw new Error(`Unknown participant: ${participantId}`);
    }
    if (participant.kind !== "human") {
      throw new Error("Only human participants can bind a connection");
    }
    session.participantConnections.set(participantId, connectionId);
    session.state = {
      ...session.state,
      participants: session.state.participants.map((p) =>
        p.id === participantId ? { ...p, connectionId } : p,
      ),
    };
    persistSession(session);
    return participantId;
  }

  const unboundHuman = session.state.participants.find(
    (p) => p.kind === "human" && !p.connectionId,
  );
  if (unboundHuman) {
    session.participantConnections.set(unboundHuman.id, connectionId);
    session.state = {
      ...session.state,
      participants: session.state.participants.map((p) =>
        p.id === unboundHuman.id ? { ...p, connectionId } : p,
      ),
    };
    persistSession(session);
    return unboundHuman.id;
  }

  return null;
}

export function detachConnection(session: SessionRecord, connectionId: string): void {
  session.connections.delete(connectionId);

  for (const [participantId, boundId] of session.participantConnections) {
    if (boundId === connectionId) {
      session.participantConnections.delete(participantId);
      session.state = {
        ...session.state,
        participants: session.state.participants.map((p) =>
          p.id === participantId ? { ...p, connectionId: undefined } : p,
        ),
      };
      if (session.waitingForHuman === participantId) {
        session.waitingForHuman = null;
      }
      persistSession(session);
    }
  }
}

export function broadcast(session: SessionRecord, localByConnection?: Map<string, ParticipantId | null>): void {
  persistSession(session);
  for (const [connectionId, ws] of session.connections) {
    if (ws.readyState !== ws.OPEN) {
      continue;
    }
    const localParticipantId =
      localByConnection?.get(connectionId) ??
      [...session.participantConnections.entries()].find(([, cid]) => cid === connectionId)?.[0] ??
      null;

    ws.send(
      JSON.stringify({
        type: "session.updated",
        state: publicState(session, localParticipantId),
        localParticipantId,
      }),
    );
  }
}
