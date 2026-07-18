import type { CoordinatorDeps, TableState } from "@llm-table/shared";
import { extractXmlTag } from "@llm-table/shared";
import { getAdventureSeed } from "./seeds.js";
import { isRpgState, type RpgState } from "./types.js";

export const SUMMARY_EVERY_MESSAGES = 25;
export const SUMMARY_MAX_CHARS = 2000;

export function normalizeRpgState(rpg: RpgState): RpgState {
  const mode = rpg.advance?.mode;
  const advanceMode =
    mode === "preparing" ||
    mode === "ready" ||
    mode === "awaiting_human" ||
    mode === "idle"
      ? mode
      : "idle";

  let adventure = rpg.adventure;
  if (!adventure || typeof adventure !== "object") {
    try {
      adventure = getAdventureSeed(rpg.seedId);
    } catch {
      adventure = {
        id: rpg.seedId,
        title: rpg.publicSeed?.title ?? "Adventure",
        tone: rpg.publicSeed?.tone ?? "",
        premise: rpg.publicSeed?.premise ?? rpg.sceneSummary ?? "",
        locations: [],
        npcs: [],
        secret: typeof rpg.secret === "string" ? rpg.secret : "",
      };
    }
  }

  return {
    ...rpg,
    adventure,
    transcriptSummary:
      typeof rpg.transcriptSummary === "string" ? rpg.transcriptSummary : "",
    summaryThroughMessageCount:
      typeof rpg.summaryThroughMessageCount === "number" &&
      Number.isFinite(rpg.summaryThroughMessageCount)
        ? Math.max(0, Math.trunc(rpg.summaryThroughMessageCount))
        : 0,
    advance: {
      speakerId:
        typeof rpg.advance?.speakerId === "string" ? rpg.advance.speakerId : null,
      mode: advanceMode,
    },
  };
}

export function formatRpgPromptMemory(state: TableState, recentWindow: number): string {
  if (!isRpgState(state.moduleState)) {
    return [
      "Prior session summary:",
      "(none yet)",
      "",
      "Recent transcript:",
      "(quiet)",
    ].join("\n");
  }
  const rpg = normalizeRpgState(state.moduleState);
  const recent = state.messages.slice(-recentWindow);
  return [
    "Prior session summary:",
    rpg.transcriptSummary.trim() || "(none yet)",
    "",
    "Recent transcript:",
    recent.length > 0
      ? recent.map((m) => `${m.displayName}: ${m.content}`).join("\n")
      : "(quiet)",
  ].join("\n");
}

/**
 * When at least SUMMARY_EVERY_MESSAGES messages have arrived since the last fold,
 * compress them into transcriptSummary for LLM prompts. UI keeps the full transcript.
 * Failures leave state unchanged so the next action can retry.
 */
export async function maybeRefreshTranscriptSummary(
  state: TableState,
  deps: Pick<CoordinatorDeps, "apiKey" | "coordinatorModel" | "complete">,
): Promise<TableState> {
  if (!isRpgState(state.moduleState)) {
    return state;
  }

  const rpg = normalizeRpgState(state.moduleState);
  const pending = state.messages.length - rpg.summaryThroughMessageCount;
  if (pending < SUMMARY_EVERY_MESSAGES) {
    return state;
  }

  const chunk = state.messages.slice(rpg.summaryThroughMessageCount);
  const chunkText = chunk.map((m) => `${m.displayName}: ${m.content}`).join("\n");

  const system = [
    "You maintain a rolling summary of a theater-of-the-mind RPG session for other LLMs.",
    "Merge the prior summary with the new transcript chunk.",
    "Keep continuity: who did what, open questions, clues, location, NPCs, stakes, and outcomes of checks.",
    `Keep the summary under ${SUMMARY_MAX_CHARS} characters.`,
    "Respond with XML only (no markdown fences):",
    "<summary><![CDATA[updated rolling summary]]></summary>",
  ].join("\n");

  const user = [
    "Prior summary:",
    rpg.transcriptSummary.trim() || "(none yet)",
    "",
    "New transcript chunk:",
    chunkText || "(empty)",
  ].join("\n");

  try {
    const raw = await deps.complete({
      apiKey: deps.apiKey,
      model: deps.coordinatorModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    });

    const summary = extractXmlTag(raw, "summary")?.trim();
    if (!summary) {
      return state;
    }

    return {
      ...state,
      moduleState: {
        ...rpg,
        transcriptSummary: summary.slice(0, SUMMARY_MAX_CHARS),
        summaryThroughMessageCount: state.messages.length,
      },
    };
  } catch {
    return state;
  }
}
