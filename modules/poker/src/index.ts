import type { GameModule, ParticipantId, TableState } from "@llm-table/shared";
import { createPokerCoordinator } from "./coordinator.js";
import { redactPokerState } from "./engine.js";
import { generatePokerLlmTurn } from "./llmTurn.js";
import { createPokerRules, onPokerStart } from "./rules.js";
import { isPokerState } from "./types.js";

export const POKER_MODULE_ID = "poker";

export const pokerModule: GameModule = {
  id: POKER_MODULE_ID,
  displayName: "Texas Hold'em",
  createRules: createPokerRules,
  createCoordinator: () => createPokerCoordinator(),
  onStart: onPokerStart,
  generateLlmTurn: generatePokerLlmTurn,
  redactState(state: TableState, viewerId: ParticipantId | null): TableState {
    if (!isPokerState(state.moduleState)) {
      return state;
    }
    return {
      ...state,
      moduleState: redactPokerState(state.moduleState, viewerId),
    };
  },
  humanTurnTimeoutMs: null,
};

export { createPokerRules, createPokerCoordinator, generatePokerLlmTurn };
export type { PokerState } from "./types.js";
export { isAwaitingNextHand, isPokerState } from "./types.js";
export { continueToNextHand, legalActions } from "./engine.js";
export { formatCard, formatCards } from "./cards.js";
export type { Card, Rank, Suit } from "./cards.js";

