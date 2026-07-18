import type { Participant, ParticipantId, TableState } from "./types.js";
import type { ClientAction } from "./protocol.js";

export interface RulesEngine {
  apply(state: TableState, action: ClientAction, actorId: ParticipantId): TableState;
  isActive(state: TableState): boolean;
}

export interface Coordinator {
  pickNext(state: TableState): Promise<ParticipantId | null>;
}

export interface CoordinatorDeps {
  apiKey: string;
  coordinatorModel: string;
  complete: (params: {
    apiKey: string;
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    responseFormat?: "json_object";
  }) => Promise<string>;
}

export interface TurnGenerationContext {
  apiKey: string;
  complete: CoordinatorDeps["complete"];
  state: TableState;
  participant: Participant;
}

export interface GameModule {
  id: string;
  displayName: string;
  createRules(): RulesEngine;
  createCoordinator(deps: CoordinatorDeps): Coordinator;
  /** Called when a session leaves lobby and starts running. */
  onStart(state: TableState): TableState;
  /**
   * Optional LLM turn builder. When absent, the orchestrator uses plain conversation chat.
   */
  generateLlmTurn?(ctx: TurnGenerationContext): Promise<ClientAction>;
  /** Hide private info (e.g. opponents' hole cards) per viewer. */
  redactState?(state: TableState, viewerId: ParticipantId | null): TableState;
  /**
   * Human turn wait before skip (conversation) or auto-act.
   * `null` = wait indefinitely (no timeout / no auto-action).
   * Omit to use the orchestrator default.
   */
  humanTurnTimeoutMs?: number | null;
}
