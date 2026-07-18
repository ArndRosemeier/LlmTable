import type { GameModule, ParticipantId, TableState } from "@llm-table/shared";
import { createRpgCoordinator } from "./coordinator.js";
import { generateRpgLlmTurn } from "./llmTurn.js";
import {
  buildInitialRpgState,
  createRpgRules,
  onRpgStart,
  redactRpgState,
} from "./rules.js";

export const RPG_MODULE_ID = "rpg";

export const rpgModule: GameModule = {
  id: RPG_MODULE_ID,
  displayName: "Roleplaying",
  createRules: createRpgRules,
  createCoordinator: (deps) => createRpgCoordinator(deps),
  onStart: onRpgStart,
  generateLlmTurn: generateRpgLlmTurn,
  redactState(state: TableState, viewerId: ParticipantId | null): TableState {
    return redactRpgState(state, viewerId);
  },
  humanTurnTimeoutMs: null,
};

export { createRpgRules, createRpgCoordinator, generateRpgLlmTurn, buildInitialRpgState };
export { maybeRefreshTranscriptSummary, formatRpgPromptMemory, normalizeRpgState } from "./promptMemory.js";
export { isRpgState } from "./types.js";
export type {
  RpgState,
  RpgPartyMember,
  RpgLastRoll,
  RpgClockState,
  RpgAdvanceState,
  RpgPreparationPhase,
  RpgPreparationProgress,
} from "./types.js";
export {
  ADVENTURE_SEEDS,
  getAdventureSeed,
  listAdventureSeeds,
  resolveAdventureSeed,
  validateAdventureSeed,
  blankCustomSeed,
  isBuiltinAdventureSeedId,
  type AdventureSeed,
} from "./seeds.js";
export { DEFAULT_PC_HP } from "./rules.js";
export { rollDie, rollD20 } from "./dice.js";
