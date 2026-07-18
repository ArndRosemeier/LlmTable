import type { ClientAction, ParticipantId, RulesEngine, TableState } from "@llm-table/shared";
import { applyPokerAction, createInitialPokerState, startNewHand } from "./engine.js";
import { gloatQueue, isPokerState, type PokerState } from "./types.js";

function requirePoker(state: TableState): PokerState {
  if (!isPokerState(state.moduleState)) {
    throw new Error("Poker moduleState is missing or invalid");
  }
  return state.moduleState;
}

function appendTalk(
  state: TableState,
  actorId: ParticipantId,
  tableTalk: string | undefined,
  actionLabel: string,
): TableState {
  const actor = state.participants.find((p) => p.id === actorId);
  if (!actor) {
    throw new Error(`Unknown actor: ${actorId}`);
  }
  const talk = tableTalk?.trim();
  const content = talk && talk.length > 0 ? talk : `(${actionLabel})`;
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: crypto.randomUUID(),
        participantId: actorId,
        displayName: actor.displayName,
        content,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

function applyWinnerGloat(
  state: TableState,
  actorId: ParticipantId,
  content: string,
): TableState {
  const actor = state.participants.find((p) => p.id === actorId);
  if (!actor) {
    throw new Error(`Unknown actor: ${actorId}`);
  }
  if (actor.kind !== "llm") {
    throw new Error("Only LLM winners get a post-hand gloat turn");
  }

  const poker = requirePoker(state);
  if (poker.street !== "betweenHands") {
    throw new Error("Gloat turns are only allowed between hands");
  }

  const queue = gloatQueue(poker);
  if (queue[0] !== actorId) {
    throw new Error(`${actor.displayName} is not next to celebrate this pot`);
  }

  const nextQueue = queue.slice(1);
  const nextPoker: PokerState = {
    ...poker,
    pendingGloatIds: nextQueue,
  };

  return {
    ...state,
    phase: "running",
    moduleState: nextPoker,
    activeSpeakerId: nextQueue[0] ?? null,
    messages: [
      ...state.messages,
      {
        id: crypto.randomUUID(),
        participantId: actorId,
        displayName: actor.displayName,
        content,
        createdAt: new Date().toISOString(),
      },
    ],
    error: null,
    statusMessage:
      nextQueue.length > 0
        ? `${actor.displayName} celebrated — next winner…`
        : `${actor.displayName} celebrated — review the pot, then continue`,
  };
}

export function onPokerStart(state: TableState): TableState {
  const initial = createInitialPokerState(state.participants);
  const dealing = startNewHand(initial);
  return {
    ...state,
    moduleState: dealing,
    activeSpeakerId: dealing.actingParticipantId,
    statusMessage: dealing.lastActionSummary ?? "Cards are in the air",
    error: null,
  };
}

export function createPokerRules(): RulesEngine {
  return {
    apply(state, action: ClientAction, actorId: ParticipantId): TableState {
      if (action.type === "chat.say") {
        const actor = state.participants.find((p) => p.id === actorId);
        if (!actor) {
          throw new Error(`Unknown actor: ${actorId}`);
        }
        if (state.phase !== "running" && state.phase !== "paused") {
          throw new Error(`Cannot speak while session phase is "${state.phase}"`);
        }
        const content = action.content.trim();
        if (!content) {
          throw new Error("Message content must not be empty");
        }

        if (actor.kind === "llm") {
          return applyWinnerGloat(state, actorId, content);
        }

        return {
          ...state,
          phase: state.phase === "paused" ? "running" : state.phase,
          messages: [
            ...state.messages,
            {
              id: crypto.randomUUID(),
              participantId: actorId,
              displayName: actor.displayName,
              content,
              createdAt: new Date().toISOString(),
            },
          ],
          error: null,
          statusMessage: `${actor.displayName} comments from the rail`,
        };
      }

      if (action.type !== "poker.act") {
        throw new Error(`Unsupported action: ${(action as { type: string }).type}`);
      }

      if (state.phase !== "running" && state.phase !== "paused") {
        throw new Error(`Cannot act while session phase is "${state.phase}"`);
      }

      const poker = requirePoker(state);
      const nextPoker = applyPokerAction(poker, actorId, action.action, action.raiseTo);
      const label = nextPoker.lastActionSummary ?? action.action;
      const withTalk = appendTalk(
        {
          ...state,
          phase: "running",
          moduleState: nextPoker,
          activeSpeakerId: nextPoker.actingParticipantId,
          statusMessage: label,
          error: null,
        },
        actorId,
        action.tableTalk,
        label,
      );
      return withTalk;
    },

    isActive(state) {
      if (state.phase !== "running") {
        return false;
      }
      if (!isPokerState(state.moduleState)) {
        return false;
      }
      const poker = state.moduleState;
      // Finish the current hand even if some players are already all-in at 0 chips.
      if (poker.street !== "betweenHands") {
        return true;
      }
      if (gloatQueue(poker).length > 0) {
        return true;
      }
      return poker.players.filter((p) => p.stack > 0).length >= 2;
    },
  };
}
