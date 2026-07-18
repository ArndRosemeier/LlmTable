import type { ClientAction, ParticipantId, RulesEngine, TableState } from "@llm-table/shared";
import { applyPokerAction, createInitialPokerState, startNewHand } from "./engine.js";
import { isPokerState, type PokerState } from "./types.js";

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
        if (actor.kind !== "human") {
          throw new Error("During poker, LLM players must act with poker.act");
        }
        if (state.phase !== "running" && state.phase !== "paused") {
          throw new Error(`Cannot speak while session phase is "${state.phase}"`);
        }
        const content = action.content.trim();
        if (!content) {
          throw new Error("Message content must not be empty");
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
      return state.moduleState.players.filter((p) => p.stack > 0).length >= 2;
    },
  };
}
