import type { GameModule } from "@llm-table/shared";
import { createConversationCoordinator } from "./coordinator.js";
import { createConversationRules } from "./rules.js";

export const CONVERSATION_MODULE_ID = "conversation";

export const conversationModule: GameModule = {
  id: CONVERSATION_MODULE_ID,
  displayName: "Conversation",
  createRules: createConversationRules,
  createCoordinator: createConversationCoordinator,
  onStart(state) {
    return {
      ...state,
      statusMessage: "Conversation starting…",
    };
  },
  humanTurnTimeoutMs: 20_000,
};

export { createConversationRules, createConversationCoordinator };
