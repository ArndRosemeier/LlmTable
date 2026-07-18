import { conversationModule } from "@llm-table/conversation";
import { pokerModule } from "@llm-table/poker";
import { rpgModule } from "@llm-table/rpg";
import type { GameModule } from "@llm-table/shared";

const modules = new Map<string, GameModule>([
  [conversationModule.id, conversationModule],
  [pokerModule.id, pokerModule],
  [rpgModule.id, rpgModule],
]);

export function getModule(moduleId: string): GameModule {
  const mod = modules.get(moduleId);
  if (!mod) {
    throw new Error(`Unknown game module: ${moduleId}`);
  }
  return mod;
}
