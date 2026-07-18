import type { ClientAction, TurnGenerationContext } from "@llm-table/shared";
import {
  extractXmlTag,
  formatPersonaVisualCastLine,
  requireXmlTag,
} from "@llm-table/shared";
import { formatRpgPromptMemory, normalizeRpgState } from "./promptMemory.js";
import { gmSeedBriefing } from "./rules.js";
import { isRpgState } from "./types.js";

const PC_OVERLAY = [
  "RULE LAYER — HARD CONSTRAINTS. You are a PLAYER CHARACTER only. The GM is the sole world master.",
  "- Stay in your persona's voice, mannerisms, and outlook.",
  "- Your <content> may ONLY be one of:",
  "  (1) dialogue your character speaks aloud,",
  "  (2) a first-person INTENT: what you try / want to do (not what happens),",
  "  (3) a short question asking the GM for information.",
  "- Frame actions as intent for the GM to resolve: \"I try to…\", \"I want to…\", \"I reach for…\", \"I tell them…\".",
  "- FORBIDDEN in <content> (instant failure if you do any of these):",
  "  • narrating the world, scenery, atmosphere, or \"what happens next\"",
  "  • describing results, reactions, NPC/monster actions, or other PCs",
  "  • past-tense storytelling of successful outcomes (\"I open the door and see…\", \"the guard falls…\")",
  "  • omniscient or third-person prose about the scene",
  "  • inventing dice rolls, damage, or mechanical success/failure",
  "- The GM alone says what actually happens after your intent.",
  "- Keep it short: one or two sentences of speech and/or intent. No scene-writing.",
  "",
  "BAD (world narration — never do this):",
  "  \"I slip past the guard. The hall beyond is dark; a torch gutters as I enter.\"",
  "GOOD (intent only):",
  "  \"I try to slip past the guard into the hall — quietly, staying low.\"",
  "BAD:",
  "  \"My blade finds his throat and he collapses without a sound.\"",
  "GOOD:",
  "  \"I try to silence him with a quick strike — aiming for a quiet take-down.\"",
].join("\n");

const GM_OVERLAY_BASE = [
  "RULE LAYER — You are the Game Master, but you are still yourself:",
  "- Run the table entirely in your persona's voice, tone, humor, vocabulary, and attitude.",
  "- Do not sound like a generic RPG narrator. If your persona is dry, warm, theatrical, terse, etc., the narration must feel like that person GMing.",
  "- Your job is GM work only: describe the world, portray NPCs, call for checks when stakes matter, keep continuity.",
  "- HARD BAN — never act for a player character. Never write PC dialogue, never decide a PC's words/choices/actions, never puppet a PC.",
  "- PCs own their voices and intents. You resolve the world AFTER they declare what they try — you do not speak as them.",
  "- NPCs and the environment are yours; player characters are not.",
  "- Honor adventure seed facts; improvise freely between them. Never contradict the secret once established.",
  "- You are final arbiter of the world and soft house rules.",
  "- Never invent dice results. To call a check, fill the <check> block; the app rolls.",
  "- Update <sceneSummary> to a short current-situation blurb (max ~500 chars).",
  "- Use clockDelta only when time/pressure meaningfully advances (integer, may be 0/omit).",
  "- Optional hpUpdates: JSON array [{\"participantId\":\"...\",\"hp\":number}].",
  "- Soft house rules; D&D flavor only — not full 5e compliance.",
  "",
  "BAD (acting for a PC — never):",
  "  \"Avery snarls 'Stand aside!' and charges the door.\"",
  "GOOD (world only; wait for the PC's own line):",
  "  \"The door shudders under the impact — hinges scream. What do you do?\"",
].join("\n");

const GM_IMAGE_RULE = [
  "- Optional imagePrompt: a vivid visual description for a picture to show the party. Use sparingly for striking moments — leave empty most turns.",
  "- When you fill imagePrompt, describe people VISUALLY — do not rely on character names (names are useless for the image model):",
  "  • For each person in frame: sex/gender presentation, age/build, hair, skin, clothing, gear, and any distinctive marks.",
  "  • Prefer the visual roster cues below when a PC appears; invent clear looks only for NPCs not listed there.",
  "  • State who is present vs absent — do not imply the whole party is in frame unless they are.",
  "  • Pose, expression, and placement (foreground/background, facing, interacting with what).",
  "  • Prefer one clear focal subject (or a tight group you can fully specify) over a crowded anonymous cast.",
].join("\n");

const GM_NO_IMAGE_RULE =
  "- Do not request pictures. Leave imagePrompt empty (images are disabled for this table).";


function parseHpUpdates(raw: string): Array<{ participantId: string; hp: number }> | undefined {
  const text = extractXmlTag(raw, "hpUpdates");
  if (text === null || !text.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const updates: Array<{ participantId: string; hp: number }> = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const row = item as { participantId?: unknown; hp?: unknown };
      if (typeof row.participantId !== "string" || typeof row.hp !== "number") {
        continue;
      }
      updates.push({ participantId: row.participantId, hp: row.hp });
    }
    return updates.length > 0 ? updates : undefined;
  } catch {
    return undefined;
  }
}

function parseGmTurn(raw: string): Extract<ClientAction, { type: "rpg.gm" }> {
  const narration = requireXmlTag(raw, "narration").trim();
  if (!narration) {
    throw new Error("GM turn missing narration");
  }

  const sceneSummary = extractXmlTag(raw, "sceneSummary")?.trim();
  const clockRaw = extractXmlTag(raw, "clockDelta")?.trim();
  let clockDelta: number | undefined;
  if (clockRaw) {
    const n = Number(clockRaw);
    if (Number.isFinite(n)) {
      clockDelta = Math.trunc(n);
    }
  }

  const checkParticipantId = extractXmlTag(raw, "participantId");
  const checkLabel = extractXmlTag(raw, "label");
  const checkDc = extractXmlTag(raw, "dc");
  const checkMod = extractXmlTag(raw, "modifier");

  let check: Extract<ClientAction, { type: "rpg.gm" }>["check"];
  if (checkParticipantId?.trim() && checkDc?.trim()) {
    const dc = Number(checkDc);
    const modifier = Number(checkMod?.trim() || "0");
    if (Number.isFinite(dc) && Number.isFinite(modifier)) {
      check = {
        participantId: checkParticipantId.trim(),
        label: (checkLabel ?? "check").trim() || "check",
        dc: Math.trunc(dc),
        modifier: Math.trunc(modifier),
      };
    }
  }

  return {
    type: "rpg.gm",
    narration,
    sceneSummary: sceneSummary || undefined,
    check,
    hpUpdates: parseHpUpdates(raw),
    clockDelta,
    imagePrompt: extractXmlTag(raw, "imagePrompt")?.trim() || undefined,
  };
}

async function generateGmTurn(ctx: TurnGenerationContext): Promise<ClientAction> {
  const { participant, state } = ctx;
  if (!participant.persona) {
    throw new Error("GM has no persona definition");
  }
  if (!isRpgState(state.moduleState)) {
    throw new Error("RPG state missing");
  }
  const rpg = normalizeRpgState(state.moduleState);

  const roster = state.participants
    .map((p) => {
      const member = rpg.party.find((m) => m.participantId === p.id);
      const hp = member ? ` HP ${member.hp}/${member.maxHp}` : "";
      return `- ${p.displayName} id=${p.id} role=${p.tableRole ?? "pc"}${hp}`;
    })
    .join("\n");

  const imagesEnabled = state.gmImagesEnabled === true;
  const gmOverlay = [GM_OVERLAY_BASE, imagesEnabled ? GM_IMAGE_RULE : GM_NO_IMAGE_RULE].join(
    "\n",
  );

  const system = [
    `You are ${participant.displayName}, and you are running this roleplaying table as GM.`,
    participant.persona.systemPrompt.trim(),
    "",
    gmOverlay,
    "",
    "Adventure seed:",
    gmSeedBriefing(rpg),
    "",
    "Respond with XML only:",
    "<turn>",
    "  <narration><![CDATA[what you say / describe — in your own voice]]></narration>",
    "  <sceneSummary><![CDATA[short current situation]]></sceneSummary>",
    "  <clockDelta></clockDelta>",
    "  <participantId></participantId>",
    "  <label></label>",
    "  <dc></dc>",
    "  <modifier></modifier>",
    "  <hpUpdates><![CDATA[]]></hpUpdates>",
    imagesEnabled
      ? "  <imagePrompt><![CDATA[]]></imagePrompt>"
      : "  <imagePrompt></imagePrompt>",
    "</turn>",
    imagesEnabled
      ? "Leave check fields and imagePrompt empty when unused. hpUpdates empty or JSON array. If imagePrompt is used, describe people by sex and look — not by name."
      : "Leave check fields empty when unused. Always leave imagePrompt empty. hpUpdates empty or JSON array.",
  ].join("\n");

  const visualRoster = state.participants
    .filter((p) => p.tableRole !== "gm" && p.persona?.systemPrompt.trim())
    .map((p) => `- ${formatPersonaVisualCastLine(p.persona!.systemPrompt)}`)
    .join("\n");

  const user = [
    `Scene summary: ${rpg.sceneSummary}`,
    rpg.clock ? `Clock ${rpg.clock.name}: ${rpg.clock.value}/${rpg.clock.max}` : "Clock: none",
    rpg.lastRoll
      ? `Last roll: ${rpg.lastRoll.label} total ${rpg.lastRoll.total} vs ${rpg.lastRoll.dc} (${rpg.lastRoll.success ? "success" : "failure"})`
      : "Last roll: none",
    "",
    "Roster:",
    roster,
    ...(imagesEnabled && visualRoster
      ? ["", "Visual roster for imagePrompt (sex + persona look cues; do not put names in imagePrompt):", visualRoster]
      : []),
    "",
    formatRpgPromptMemory(state, 16),
    "",
    `Take your GM turn as ${participant.displayName} — stay in persona.`,
    "Narrate the world and NPCs only. Do not speak or act for any player character.",
  ].join("\n");

  const raw = await ctx.complete({
    apiKey: ctx.apiKey,
    model: participant.persona.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.85,
  });

  const action = parseGmTurn(raw);
  if (!imagesEnabled && action.imagePrompt) {
    return { ...action, imagePrompt: undefined };
  }
  return action;
}

async function generatePcTurn(ctx: TurnGenerationContext): Promise<ClientAction> {
  const { participant, state } = ctx;
  if (!participant.persona) {
    throw new Error(`${participant.displayName} has no persona definition`);
  }
  if (!isRpgState(state.moduleState)) {
    throw new Error("RPG state missing");
  }
  const rpg = normalizeRpgState(state.moduleState);
  const me = rpg.party.find((m) => m.participantId === participant.id);

  const system = [
    `You are ${participant.displayName}, a player character at this roleplaying table.`,
    "You do not control the world. You only control what your character says and what they attempt.",
    participant.persona.systemPrompt.trim(),
    "",
    PC_OVERLAY,
    "",
    "Respond with XML only:",
    "<turn>",
    "  <content><![CDATA[dialogue and/or first-person INTENT to the GM — never world narration]]></content>",
    "  <isAction>true|false</isAction>",
    "</turn>",
    "isAction=true when declaring a physical/risky attempt; false for pure dialogue or questions to the GM.",
    "If you catch yourself describing what happens after the attempt, delete that and leave only the intent.",
  ].join("\n");

  const user = [
    `Adventure: ${rpg.publicSeed.title} — ${rpg.publicSeed.premise}`,
    `Scene (GM's authority — do not rewrite or extend it): ${rpg.sceneSummary}`,
    me ? `Your HP: ${me.hp}/${me.maxHp}; tags: ${me.tags.join(", ") || "(none)"}` : "Your vitals: unknown",
    rpg.lastRoll && rpg.lastRoll.participantId === participant.id
      ? `Your last check (${rpg.lastRoll.label}): ${rpg.lastRoll.success ? "success" : "failure"} (${rpg.lastRoll.total} vs DC ${rpg.lastRoll.dc})`
      : "",
    "",
    formatRpgPromptMemory(state, 16),
    "",
    `Your turn as ${participant.displayName}.`,
    "Tell the GM what you say and/or what you INTEND to try. Stop before any outcome. The GM resolves the world.",
  ].join("\n");

  const raw = await ctx.complete({
    apiKey: ctx.apiKey,
    model: participant.persona.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.75,
  });

  const content = requireXmlTag(raw, "content").trim();
  if (!content) {
    throw new Error("PC turn returned empty content");
  }
  const isActionRaw = (extractXmlTag(raw, "isAction") ?? "false").trim().toLowerCase();
  const isAction = isActionRaw === "true" || isActionRaw === "1" || isActionRaw === "yes";

  return { type: "rpg.say", content, isAction };
}

export async function generateRpgLlmTurn(ctx: TurnGenerationContext): Promise<ClientAction> {
  if (ctx.participant.tableRole === "gm") {
    return generateGmTurn(ctx);
  }
  return generatePcTurn(ctx);
}
