import type { ChatMessage, TableState } from "@llm-table/shared";

/** How many hands of table talk to keep in the chat / LLM context. */
export const POKER_CHAT_HAND_WINDOW = 3;

/**
 * Keep messages from the last `windowHands` hands ending at `currentHandNumber`.
 * Untagged legacy lines are dropped once the table is past the window.
 */
export function trimPokerMessages(
  messages: ChatMessage[],
  currentHandNumber: number,
  windowHands: number = POKER_CHAT_HAND_WINDOW,
): ChatMessage[] {
  if (currentHandNumber <= 0 || messages.length === 0) {
    return messages;
  }
  const minHand = Math.max(1, currentHandNumber - windowHands + 1);
  return messages.filter((m) => {
    if (typeof m.handNumber !== "number" || !Number.isFinite(m.handNumber)) {
      return currentHandNumber <= windowHands;
    }
    const hand = Math.trunc(m.handNumber);
    return hand >= minHand && hand <= currentHandNumber;
  });
}

export function withPokerChatWindow(
  state: TableState,
  currentHandNumber: number,
  windowHands: number = POKER_CHAT_HAND_WINDOW,
): TableState {
  const messages = trimPokerMessages(state.messages, currentHandNumber, windowHands);
  if (messages.length === state.messages.length) {
    return state;
  }
  return { ...state, messages };
}
