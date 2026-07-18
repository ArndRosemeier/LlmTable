import { conversationModule } from "@llm-table/conversation";
import { pokerModule } from "@llm-table/poker";
import type { GameModule } from "@llm-table/shared";

const modules = new Map<string, GameModule>([
  [conversationModule.id, conversationModule],
  [pokerModule.id, pokerModule],
]);

export function getModule(moduleId: string): GameModule {
  const mod = modules.get(moduleId);
  if (!mod) {
    throw new Error(`Unknown game module: ${moduleId}`);
  }
  return mod;
}

export function listModules(): Array<{ id: string; displayName: string }> {
  return [...modules.values()].map((m) => ({
    id: m.id,
    displayName: m.displayName,
  }));
}
