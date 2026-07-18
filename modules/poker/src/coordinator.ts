import type { Coordinator, ParticipantId, TableState } from "@llm-table/shared";
import { maybeStartNextHand } from "./engine.js";
import { isPokerState } from "./types.js";

/**
 * Heuristic seat coordinator: always the player who owes an action.
 * Starts the next hand when the previous one finished.
 */
export function createPokerCoordinator(): Coordinator {
  return {
    async pickNext(state: TableState): Promise<ParticipantId | null> {
      if (!isPokerState(state.moduleState)) {
        throw new Error("Poker moduleState is missing or invalid");
      }

      let poker = state.moduleState;
      if (poker.street === "betweenHands") {
        poker = maybeStartNextHand(poker);
        // Mutate moduleState so the table advances between hands
        (state as TableState).moduleState = poker;
        if (poker.lastActionSummary) {
          (state as TableState).statusMessage = poker.lastActionSummary;
        }
      }

      return poker.actingParticipantId;
    },
  };
}
