import type { ClientAction, ParticipantId, RulesEngine, TableState } from "@llm-table/shared";

function assertActorMaySpeak(state: TableState, actorId: ParticipantId): void {
  const actor = state.participants.find((p) => p.id === actorId);
  if (!actor) {
    throw new Error(`Unknown actor: ${actorId}`);
  }

  // Humans may interrupt whenever the table is live (running or paused).
  if (actor.kind === "human") {
    if (state.phase !== "running" && state.phase !== "paused") {
      throw new Error(`Cannot speak while session phase is "${state.phase}"`);
    }
    return;
  }

  if (state.phase !== "running") {
    throw new Error(`Cannot speak while session phase is "${state.phase}"`);
  }
  if (state.activeSpeakerId !== actorId) {
    throw new Error("It is not this participant's turn to speak");
  }
}

export function createConversationRules(): RulesEngine {
  return {
    apply(state, action: ClientAction, actorId: ParticipantId): TableState {
      if (action.type !== "chat.say") {
        throw new Error(`Unsupported action: ${(action as { type: string }).type}`);
      }

      const content = action.content.trim();
      if (content.length === 0) {
        throw new Error("Message content must not be empty");
      }

      assertActorMaySpeak(state, actorId);

      const actor = state.participants.find((p) => p.id === actorId);
      if (!actor) {
        throw new Error(`Unknown actor: ${actorId}`);
      }

      const nextPhase = state.phase === "paused" && actor.kind === "human" ? "running" : state.phase;

      return {
        ...state,
        phase: nextPhase,
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
        activeSpeakerId: null,
        error: null,
        statusMessage: actor.kind === "human" ? `${actor.displayName} interrupted` : null,
      };
    },

    isActive(state) {
      return state.phase === "running";
    },
  };
}
