import type {
  ClientAction,
  Participant,
  ParticipantId,
  TableState,
} from "@llm-table/shared";
import { chatCompletion } from "./openrouter.js";
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

export async function startSession(session: SessionRecord): Promise<void> {
  if (session.state.phase === "running") {
    return;
  }
  const mod = getModule(session.state.moduleId);
  session.state = {
    ...mod.onStart(session.state),
    phase: "running",
    error: null,
  };
  if (!session.state.statusMessage) {
    session.state.statusMessage = "Starting…";
  }
  broadcast(session);
  void runTurnLoop(session);
}

export function pauseSession(session: SessionRecord): void {
  session.turnGeneration += 1;
  session.waitingForHuman = null;
  session.state = {
    ...session.state,
    phase: "paused",
    activeSpeakerId: null,
    statusMessage: "Paused",
    error: null,
  };
  broadcast(session);
}

export async function resumeSession(session: SessionRecord): Promise<void> {
  if (session.state.phase === "running") {
    return;
  }
  session.state = {
    ...session.state,
    phase: "running",
    statusMessage: "Resuming…",
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

  session.state = rules.apply(session.state, action, actorId);

  if (actor.kind === "human") {
    setStatus(
      session,
      action.type === "poker.act"
        ? `${actor.displayName} acted — next player…`
        : `${actor.displayName} spoke — continuing…`,
    );
  } else {
    setStatus(session, "Continuing…");
  }
  broadcast(session);

  if (session.state.phase === "running") {
    void runTurnLoop(session);
  }
}

export async function runTurnLoop(session: SessionRecord): Promise<void> {
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
          // Poker (and other no-timeout modules): wait forever — pause until they reconnect/act.
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
        // Block this loop generation until the human acts, pauses, or disconnect handling via submit/pause.
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
      const action = mod.generateLlmTurn
        ? await mod.generateLlmTurn({
            apiKey: session.secrets.apiKey,
            complete: chatCompletion,
            state: session.state,
            participant: speaker,
          })
        : await generateConversationLine(session, speaker);

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
