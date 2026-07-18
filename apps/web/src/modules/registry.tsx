import type { ComponentType } from "react";
import type { ClientAction, ParticipantId, TableState } from "@llm-table/shared";
import { ConversationTableView } from "./conversation/ConversationTableView";
import { PokerTableView } from "./poker/PokerTableView";
import { RpgTableView } from "./rpg/RpgTableView";

export interface VisualizationProps {
  state: TableState;
  localParticipantId: ParticipantId | null;
  onAction: (action: ClientAction) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  /** Poker: confirm dealing the next hand after reviewing results. */
  onNextHand?: () => void;
  /** RPG: reveal the next prefetched speaker line. */
  onAdvance?: () => void;
}

const visualizations = new Map<string, ComponentType<VisualizationProps>>([
  ["conversation", ConversationTableView as ComponentType<VisualizationProps>],
  ["poker", PokerTableView],
  ["rpg", RpgTableView as ComponentType<VisualizationProps>],
]);

export function getVisualization(moduleId: string): ComponentType<VisualizationProps> {
  const viz = visualizations.get(moduleId);
  if (!viz) {
    throw new Error(`No visualization registered for module: ${moduleId}`);
  }
  return viz;
}
