import type { Coordinator, ParticipantId, TableState } from "@llm-table/shared";
import { gloatQueue, isPokerState, type PokerState } from "./types.js";

function llmGloatQueue(state: TableState, poker: PokerState): ParticipantId[] {
  return gloatQueue(poker).filter((id) => {
    const participant = state.participants.find((p) => p.id === id);
    return participant?.kind === "llm";
  });
}

/**
 * Heuristic seat coordinator: always the player who owes an action.
 * After a hand, LLM winners gloat, then the table waits for a human to deal again.
 */
export function createPokerCoordinator(): Coordinator {
  return {
    async pickNext(state: TableState): Promise<ParticipantId | null> {
      if (!isPokerState(state.moduleState)) {
        throw new Error("Poker moduleState is missing or invalid");
      }

      let poker = state.moduleState;
      if (poker.street === "betweenHands") {
        const gloats = llmGloatQueue(state, poker);
        if (gloats.length !== gloatQueue(poker).length || !Array.isArray(poker.pendingGloatIds)) {
          poker = { ...poker, pendingGloatIds: gloats };
          state.moduleState = poker;
        }

        if (gloats.length > 0) {
          const speakerId = gloats[0];
          const speaker = state.participants.find((p) => p.id === speakerId);
          state.statusMessage = speaker
            ? `${speaker.displayName} enjoys the pot…`
            : "Winner takes a moment…";
          return speakerId;
        }

        const remaining = poker.players.filter((p) => p.stack > 0);
        if (remaining.length < 2) {
          if (poker.awaitingNextHand) {
            poker = { ...poker, awaitingNextHand: false };
            state.moduleState = poker;
          }
          const champ = remaining[0];
          const champName = champ
            ? (state.participants.find((p) => p.id === champ.participantId)?.displayName ??
              "Champion")
            : null;
          state.statusMessage = champName
            ? `${champName} wins the table`
            : "Table finished — not enough chips to continue";
          return null;
        }

        if (!poker.awaitingNextHand) {
          poker = { ...poker, awaitingNextHand: true };
          state.moduleState = poker;
        }

        const summary = poker.lastActionSummary?.trim();
        state.statusMessage = summary
          ? `${summary} — press Next hand when ready`
          : "Hand complete — press Next hand when ready";
        return null;
      }

      return poker.actingParticipantId;
    },
  };
}
