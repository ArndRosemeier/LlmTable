import type { ParticipantId } from "@llm-table/shared";
import type { Card } from "./cards.js";

export type PokerStreet =
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown"
  | "betweenHands";

export type PokerPlayerStatus = "active" | "folded" | "allIn";

export interface PokerPlayerState {
  participantId: ParticipantId;
  stack: number;
  holeCards: Card[];
  betThisStreet: number;
  contributed: number;
  status: PokerPlayerStatus;
  hasActedThisStreet: boolean;
}

export interface PokerWinner {
  participantId: ParticipantId;
  amount: number;
  handName: string;
}

export interface PokerState {
  street: PokerStreet;
  deck: Card[];
  communityCards: Card[];
  pot: number;
  dealerSeatIndex: number;
  smallBlind: number;
  bigBlind: number;
  currentBet: number;
  minRaise: number;
  actingParticipantId: ParticipantId | null;
  players: PokerPlayerState[];
  handNumber: number;
  winners: PokerWinner[];
  lastActionSummary: string | null;
}

export const DEFAULT_STACK = 1000;
export const DEFAULT_SMALL_BLIND = 5;
export const DEFAULT_BIG_BLIND = 10;

export function isPokerState(value: unknown): value is PokerState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Partial<PokerState>;
  return Array.isArray(v.players) && typeof v.street === "string";
}
