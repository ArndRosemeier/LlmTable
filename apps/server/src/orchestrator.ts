import type {
  ClientAction,
  Participant,
  ParticipantId,
  TableState,
} from "@llm-table/shared";
import { continueToNextHand, isAwaitingNextHand, isPokerState } from "@llm-table/poker";
import {
  isRpgState,
  maybeRefreshTranscriptSummary,
  normalizeRpgState,
} from "@llm-table/rpg";
import { chatCompletion, generateImage } from "./openrouter.js";
import { getModule } from "./registry.js";
import {
  broadcast,
  type SessionRecord,
} from "./session.js";

const TRANSCRIPT_WINDOW = 40;
const DEFAULT_HUMAN_TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForHumanTurnOrTimeout(
  session: SessionRecord,
  humanId: ParticipantId,
  generation: number,
  timeoutMs: number,
): Promise<"spoke" | "timeout" | "cancelled" | "disconnected"> {
  const deadline = Date.now() + timeoutMs;

  const classifyClear = (): "spoke" | "cancelled" | "disconnected" => {
    if (session.turnGeneration !== generation || session.state.phase !== "running") {
      return "cancelled";
    }
    const human = session.state.participants.find((p) => p.id === humanId);
    if (!human?.connectionId) {
      return "disconnected";
    }
    return "spoke";
  };

  while (Date.now() < deadline) {
    if (session.turnGeneration !== generation || session.state.phase !== "running") {
      return "cancelled";
    }
    if (session.waitingForHuman !== humanId) {
      return classifyClear();
    }
    await sleep(200);
  }

  if (session.turnGeneration !== generation || session.state.phase !== "running") {
    return "cancelled";
  }
  if (session.waitingForHuman !== humanId) {
    return classifyClear();
  }
  return "timeout";
}

function setStatus(session: SessionRecord, statusMessage: string | null, error: string | null = null): void {
  session.state = {
    ...session.state,
    statusMessage,
    error,
  };
}

function findParticipant(state: TableState, id: ParticipantId): Participant {
  const p = state.participants.find((x) => x.id === id);
  if (!p) {
    throw new Error(`Unknown participant: ${id}`);
  }
  return p;
}

function isRpgModule(session: SessionRecord): boolean {
  return session.state.moduleId === "rpg";
}

function withRpgAdvance(
  state: TableState,
  advance: { speakerId: ParticipantId | null; mode: "idle" | "preparing" | "ready" | "awaiting_human" },
): TableState {
  if (!isRpgState(state.moduleState)) {
    return state;
  }
  const rpg = normalizeRpgState(state.moduleState);
  return {
    ...state,
    moduleState: {
      ...rpg,
      advance,
    },
  };
}

async function maybeRefreshRpgSummary(session: SessionRecord): Promise<void> {
  if (!isRpgModule(session)) {
    return;
  }
  const next = await maybeRefreshTranscriptSummary(session.state, {
    apiKey: session.secrets.apiKey,
    coordinatorModel: session.state.coordinatorModel,
    complete: chatCompletion,
  });
  if (next !== session.state) {
    session.state = next;
  }
}

function formatTranscriptForPersona(state: TableState): string {
  const recent = state.messages.slice(-TRANSCRIPT_WINDOW);
  if (recent.length === 0) {
    return "The table is quiet. Start the conversation naturally in character.";
  }
  return recent.map((m) => `${m.displayName}: ${m.content}`).join("\n");
}

async function generateConversationLine(
  session: SessionRecord,
  speaker: Participant,
): Promise<ClientAction> {
  if (!speaker.persona) {
    throw new Error(`LLM participant ${speaker.displayName} has no persona definition`);
  }

  const others = session.state.participants
    .filter((p) => p.id !== speaker.id)
    .map((p) => p.displayName)
    .join(", ");

  const system = [
    speaker.persona.systemPrompt,
    "",
    "You are seated at a conversation table with: " + (others || "no one else yet") + ".",
    "Stay in character. Reply with only what you say at the table — no stage directions, no name prefix.",
    "Keep replies concise (1–3 short paragraphs unless the moment clearly needs more).",
  ].join("\n");

  const content = await chatCompletion({
    apiKey: session.secrets.apiKey,
    model: speaker.persona.model,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Transcript so far:\n${formatTranscriptForPersona(session.state)}\n\nSpeak now as ${speaker.displayName}.`,
      },
    ],
    temperature: 0.8,
  });

  return { type: "chat.say", content };
}

async function generateLlmAction(
  session: SessionRecord,
  speaker: Participant,
): Promise<ClientAction> {
  const mod = getModule(session.state.moduleId);
  if (mod.generateLlmTurn) {
    return mod.generateLlmTurn({
      apiKey: session.secrets.apiKey,
      complete: chatCompletion,
      state: session.state,
      participant: speaker,
    });
  }
  return generateConversationLine(session, speaker);
}

/** If the GM requested a picture, generate it with the session image model (soft-fail). */
async function maybeAttachGmImage(
  session: SessionRecord,
  action: ClientAction,
): Promise<ClientAction> {
  if (action.type !== "rpg.gm") {
    return action;
  }
  const prompt = action.imagePrompt?.trim();
  if (!prompt) {
    return action;
  }
  const model = session.state.imageModel?.trim();
  if (!model) {
    return { ...action, imagePrompt: undefined };
  }

  try {
    const { dataUrl } = await generateImage({
      apiKey: session.secrets.apiKey,
      model,
      prompt: [
        "Fantasy tabletop RPG illustration for the players.",
        "Cinematic, atmospheric, no text, no UI, no watermark.",
        prompt,
      ].join(" "),
      aspectRatio: "16:9",
    });
    return { ...action, imageDataUrl: dataUrl, imagePrompt: undefined };
  } catch {
    // Narration still lands; picture is optional.
    return { ...action, imagePrompt: undefined };
  }
}

async function generateAndEnrichLlmAction(
  session: SessionRecord,
  speaker: Participant,
): Promise<ClientAction> {
  const action = await generateLlmAction(session, speaker);
  return maybeAttachGmImage(session, action);
}

/**
 * Pick the next RPG speaker and, for LLMs, prefetch their action in the background.
 * Does not apply the action until advanceRpgSession is called.
 */
export async function prepareRpgAdvance(session: SessionRecord): Promise<void> {
  if (!isRpgModule(session) || session.state.phase !== "running") {
    return;
  }
  if (!isRpgState(session.state.moduleState)) {
    throw new Error("RPG moduleState is missing or invalid");
  }

  const generation = session.turnGeneration;
  session.rpgPrefetch = null;
  session.waitingForHuman = null;

  const mod = getModule(session.state.moduleId);
  setStatus(session, "Determining next actor…");
  session.state = withRpgAdvance(session.state, { speakerId: null, mode: "idle" });
  broadcast(session);

  const coordinator = mod.createCoordinator({
    apiKey: session.secrets.apiKey,
    coordinatorModel: session.state.coordinatorModel,
    complete: chatCompletion,
  });

  let nextId: ParticipantId | null;
  try {
    nextId = await coordinator.pickNext(session.state);
  } catch (err) {
    if (generation !== session.turnGeneration) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    session.state = {
      ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
      phase: "paused",
      activeSpeakerId: null,
      error: message,
      statusMessage: "Coordinator failed",
    };
    broadcast(session);
    return;
  }

  if (generation !== session.turnGeneration || session.state.phase !== "running") {
    return;
  }

  if (!nextId) {
    session.state = {
      ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
      phase: "paused",
      activeSpeakerId: null,
      error: "No eligible actor",
      statusMessage: "Paused — no eligible actor",
    };
    broadcast(session);
    return;
  }

  const speaker = findParticipant(session.state, nextId);

  if (speaker.kind === "human") {
    // Coordinator must only return LLMs; skip and pick again.
    void prepareRpgAdvance(session);
    return;
  }

  session.state = {
    ...withRpgAdvance(session.state, {
      speakerId: speaker.id,
      mode: "preparing",
    }),
    activeSpeakerId: speaker.id,
    error: null,
    statusMessage: `Next: ${speaker.displayName} — preparing…`,
  };
  broadcast(session);

  const snapshotState = session.state;
  const promise = generateAndEnrichLlmAction({ ...session, state: snapshotState }, speaker);

  session.rpgPrefetch = {
    generation,
    speakerId: speaker.id,
    promise,
    action: null,
    error: null,
  };

  try {
    const action = await promise;
    if (
      generation !== session.turnGeneration ||
      session.state.phase !== "running" ||
      session.rpgPrefetch?.generation !== generation
    ) {
      return;
    }
    session.rpgPrefetch = {
      ...session.rpgPrefetch,
      action,
    };
    const withPicture =
      action.type === "rpg.gm" && Boolean(action.imageDataUrl?.trim());
    session.state = {
      ...withRpgAdvance(session.state, {
        speakerId: speaker.id,
        mode: "ready",
      }),
      activeSpeakerId: speaker.id,
      error: null,
      statusMessage: withPicture
        ? `Next: ${speaker.displayName} — press Next (picture ready)`
        : `Next: ${speaker.displayName} — press Next`,
    };
    broadcast(session);
  } catch (err) {
    if (generation !== session.turnGeneration) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    session.rpgPrefetch = null;
    session.state = {
      ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
      phase: "paused",
      activeSpeakerId: null,
      error: message,
      statusMessage: `${speaker.displayName} failed to prepare`,
    };
    broadcast(session);
  }
}

/** Reveal the prefetched RPG line (or wait for prepare to finish), then queue the following turn. */
export async function advanceRpgSession(session: SessionRecord): Promise<void> {
  if (!isRpgModule(session)) {
    throw new Error("Advance is only available during roleplaying");
  }
  if (session.state.phase !== "running") {
    throw new Error("Table must be running to advance");
  }
  if (!isRpgState(session.state.moduleState)) {
    throw new Error("RPG moduleState is missing or invalid");
  }
  if (session.rpgAdvanceLock) {
    return;
  }

  const rpg = normalizeRpgState(session.state.moduleState);
  if (rpg.advance.mode === "awaiting_human") {
    // Legacy mode — humans are no longer spotlighted; treat as nothing to advance.
    throw new Error("Nothing ready to advance yet");
  }
  if (rpg.advance.mode === "idle" || !rpg.advance.speakerId) {
    throw new Error("Nothing ready to advance yet");
  }

  session.rpgAdvanceLock = true;
  try {
    const speakerId = rpg.advance.speakerId;
    const speaker = findParticipant(session.state, speakerId);
    const generation = session.turnGeneration;
    let prefetch = session.rpgPrefetch;

    if (!prefetch || prefetch.speakerId !== speakerId || prefetch.generation !== generation) {
      setStatus(session, `Next: ${speaker.displayName} — preparing…`);
      session.state = withRpgAdvance(session.state, {
        speakerId,
        mode: "preparing",
      });
      broadcast(session);

      const promise = generateAndEnrichLlmAction(session, speaker);
      prefetch = {
        generation,
        speakerId,
        promise,
        action: null,
        error: null,
      };
      session.rpgPrefetch = prefetch;
    }

    if (!prefetch.action) {
      setStatus(session, `Next: ${speaker.displayName} — almost ready…`);
      broadcast(session);
      try {
        const action = await prefetch.promise;
        if (session.turnGeneration !== generation || session.state.phase !== "running") {
          return;
        }
        prefetch = { ...prefetch, action };
        session.rpgPrefetch = prefetch;
      } catch (err) {
        if (session.turnGeneration !== generation) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        session.rpgPrefetch = null;
        session.state = {
          ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
          phase: "paused",
          activeSpeakerId: null,
          error: message,
          statusMessage: `${speaker.displayName} failed to act`,
        };
        broadcast(session);
        return;
      }
    }

    const action = prefetch.action;
    if (!action) {
      throw new Error("Prefetch completed without an action");
    }

    // Consume this turn; invalidate any overlapping prepare.
    session.turnGeneration += 1;
    session.rpgPrefetch = null;
    session.waitingForHuman = null;

    const rules = getModule(session.state.moduleId).createRules();
    session.state = rules.apply(session.state, action, speakerId);
    await maybeRefreshRpgSummary(session);
    session.state = {
      ...withRpgAdvance(session.state, { speakerId: null, mode: "idle" }),
      activeSpeakerId: null,
      statusMessage: `${speaker.displayName} spoke — press Next when ready`,
      error: null,
    };
    broadcast(session);

    if (session.state.phase === "running") {
      void prepareRpgAdvance(session);
    }
  } finally {
    session.rpgAdvanceLock = false;
  }
}

export async function startSession(session: SessionRecord): Promise<void> {
  if (session.state.phase === "running") {
    return;
  }
  const mod = getModule(session.state.moduleId);
  session.rpgPrefetch = null;
  session.state = {
    ...mod.onStart(session.state),
    phase: "running",
    error: null,
  };
  if (isRpgModule(session) && isRpgState(session.state.moduleState)) {
    session.state = withRpgAdvance(session.state, { speakerId: null, mode: "idle" });
  }
  if (!session.state.statusMessage) {
    session.state.statusMessage = "Starting…";
  }
  broadcast(session);
  if (isRpgModule(session)) {
    void prepareRpgAdvance(session);
  } else {
    void runTurnLoop(session);
  }
}

export function pauseSession(session: SessionRecord): void {
  session.turnGeneration += 1;
  session.waitingForHuman = null;
  session.rpgPrefetch = null;
  let nextState: TableState = {
    ...session.state,
    phase: "paused",
    activeSpeakerId: null,
    statusMessage: "Paused",
    error: null,
  };
  if (isRpgState(nextState.moduleState)) {
    nextState = withRpgAdvance(nextState, { speakerId: null, mode: "idle" });
  }
  session.state = nextState;
  broadcast(session);
}

export async function resumeSession(session: SessionRecord): Promise<void> {
  if (session.state.phase === "running") {
    return;
  }
  session.rpgPrefetch = null;
  session.state = {
    ...session.state,
    phase: "running",
    statusMessage: "Resuming…",
    error: null,
  };
  if (isRpgModule(session) && isRpgState(session.state.moduleState)) {
    session.state = withRpgAdvance(session.state, { speakerId: null, mode: "idle" });
  }
  broadcast(session);
  if (isRpgModule(session)) {
    void prepareRpgAdvance(session);
  } else {
    void runTurnLoop(session);
  }
}

export async function continuePokerNextHand(session: SessionRecord): Promise<void> {
  if (session.state.moduleId !== "poker") {
    throw new Error("Next hand is only available during poker");
  }
  if (!isPokerState(session.state.moduleState)) {
    throw new Error("Poker state is missing");
  }

  session.turnGeneration += 1;
  session.waitingForHuman = null;

  const nextPoker = continueToNextHand(session.state.moduleState);
  session.state = {
    ...session.state,
    phase: "running",
    moduleState: nextPoker,
    activeSpeakerId: nextPoker.actingParticipantId,
    statusMessage: nextPoker.lastActionSummary ?? "New hand dealt",
    error: null,
  };
  broadcast(session);
  void runTurnLoop(session);
}

export async function submitAction(
  session: SessionRecord,
  actorId: ParticipantId,
  action: ClientAction,
): Promise<void> {
  const mod = getModule(session.state.moduleId);
  const rules = mod.createRules();
  const actor = findParticipant(session.state, actorId);

  session.turnGeneration += 1;
  session.waitingForHuman = null;
  session.rpgPrefetch = null;

  session.state = rules.apply(session.state, action, actorId);
  await maybeRefreshRpgSummary(session);

  if (isRpgModule(session) && isRpgState(session.state.moduleState)) {
    session.state = withRpgAdvance(session.state, { speakerId: null, mode: "idle" });
  }

  if (actor.kind === "human") {
    setStatus(
      session,
      action.type === "poker.act"
        ? `${actor.displayName} acted — next player…`
        : action.type === "rpg.say" || action.type === "rpg.gm"
          ? `${actor.displayName} interrupted — rebuilding next line…`
          : `${actor.displayName} spoke — continuing…`,
    );
  } else {
    setStatus(session, "Continuing…");
  }
  broadcast(session);

  if (session.state.phase === "running") {
    if (isRpgModule(session)) {
      void prepareRpgAdvance(session);
    } else {
      void runTurnLoop(session);
    }
  }
}

export async function runTurnLoop(session: SessionRecord): Promise<void> {
  if (isRpgModule(session)) {
    // RPG uses manual advance + prefetch instead of an auto loop.
    void prepareRpgAdvance(session);
    return;
  }

  const generation = ++session.turnGeneration;

  const stillCurrent = () =>
    generation === session.turnGeneration && session.state.phase === "running";

  while (stillCurrent()) {
    const mod = getModule(session.state.moduleId);
    const rules = mod.createRules();
    if (!rules.isActive(session.state)) {
      session.state = {
        ...session.state,
        phase: "paused",
        activeSpeakerId: null,
        statusMessage: "Table finished",
      };
      broadcast(session);
      return;
    }

    setStatus(session, "Determining next actor…");
    broadcast(session);

    const coordinator = mod.createCoordinator({
      apiKey: session.secrets.apiKey,
      coordinatorModel: session.state.coordinatorModel,
      complete: chatCompletion,
    });

    let nextId: ParticipantId | null;
    try {
      nextId = await coordinator.pickNext(session.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.state = {
        ...session.state,
        phase: "paused",
        activeSpeakerId: null,
        error: message,
        statusMessage: "Coordinator failed",
      };
      broadcast(session);
      return;
    }

    if (!stillCurrent()) {
      return;
    }

    // Coordinator may have advanced moduleState (e.g. new poker hand)
    broadcast(session);

    if (!nextId) {
      const poker = isPokerState(session.state.moduleState)
        ? session.state.moduleState
        : null;
      if (poker && isAwaitingNextHand(poker)) {
        session.state = {
          ...session.state,
          phase: "paused",
          activeSpeakerId: null,
          error: null,
          statusMessage:
            session.state.statusMessage ??
            "Hand complete — press Next hand when ready",
        };
        broadcast(session);
        return;
      }
      if (
        poker &&
        poker.street === "betweenHands" &&
        poker.players.filter((p) => p.stack > 0).length < 2
      ) {
        session.state = {
          ...session.state,
          phase: "paused",
          activeSpeakerId: null,
          error: null,
          statusMessage: session.state.statusMessage ?? "Table finished",
        };
        broadcast(session);
        return;
      }

      session.state = {
        ...session.state,
        phase: "paused",
        activeSpeakerId: null,
        error: "No eligible actor",
        statusMessage: "Paused — no eligible actor",
      };
      broadcast(session);
      return;
    }

    const speaker = findParticipant(session.state, nextId);
    const timeoutMs =
      mod.humanTurnTimeoutMs === null
        ? null
        : (mod.humanTurnTimeoutMs ?? DEFAULT_HUMAN_TIMEOUT_MS);
    session.state = {
      ...session.state,
      activeSpeakerId: nextId,
      error: null,
      statusMessage:
        speaker.kind === "human"
          ? `Waiting for ${speaker.displayName}…`
          : `${speaker.displayName} is acting…`,
    };
    broadcast(session);

    if (speaker.kind === "human") {
      if (!speaker.connectionId) {
        if (timeoutMs === null) {
          session.waitingForHuman = speaker.id;
          session.state = {
            ...session.state,
            phase: "paused",
            statusMessage: `Waiting for ${speaker.displayName} to reconnect…`,
          };
          broadcast(session);
          return;
        }
        session.state = {
          ...session.state,
          activeSpeakerId: null,
          statusMessage: `${speaker.displayName} is not connected — skipping`,
        };
        broadcast(session);
        continue;
      }

      session.waitingForHuman = speaker.id;
      session.state = {
        ...session.state,
        statusMessage:
          timeoutMs === null
            ? `Waiting for ${speaker.displayName}…`
            : `Waiting for ${speaker.displayName}… (will skip if silent)`,
      };
      broadcast(session);

      if (timeoutMs === null) {
        while (
          generation === session.turnGeneration &&
          session.state.phase === "running" &&
          session.waitingForHuman === speaker.id
        ) {
          const human = session.state.participants.find((p) => p.id === speaker.id);
          if (!human?.connectionId) {
            session.state = {
              ...session.state,
              phase: "paused",
              statusMessage: `Waiting for ${speaker.displayName} to reconnect…`,
            };
            broadcast(session);
            return;
          }
          await sleep(200);
        }
        return;
      }

      const waitResult = await waitForHumanTurnOrTimeout(
        session,
        speaker.id,
        generation,
        timeoutMs,
      );

      if (waitResult === "spoke" || waitResult === "cancelled") {
        return;
      }

      session.waitingForHuman = null;
      session.state = {
        ...session.state,
        activeSpeakerId: null,
        statusMessage:
          waitResult === "disconnected"
            ? `${speaker.displayName} disconnected — skipping`
            : `${speaker.displayName} passed — continuing`,
      };
      broadcast(session);
      continue;
    }

    try {
      const action = await generateLlmAction(session, speaker);

      if (!stillCurrent()) {
        return;
      }
      session.state = rules.apply(session.state, action, speaker.id);
      setStatus(session, "Next…");
      broadcast(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.state = {
        ...session.state,
        phase: "paused",
        activeSpeakerId: null,
        error: message,
        statusMessage: `${speaker.displayName} failed to act`,
      };
      broadcast(session);
      return;
    }
  }
}
