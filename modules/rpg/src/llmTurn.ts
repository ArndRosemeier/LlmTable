import type { ClientAction, TurnGenerationContext } from "@llm-table/shared";
import { extractXmlTag, requireXmlTag } from "@llm-table/shared";
import { formatRpgPromptMemory, normalizeRpgState } from "./promptMemory.js";
import { gmSeedBriefing } from "./rules.js";
import { isRpgState } from "./types.js";

const PC_OVERLAY = [
  "RULE LAYER — You are a PLAYER CHARACTER only (not the narrator, not the GM):",
  "- Stay fully in your persona's voice, mannerisms, and outlook.",
  "- Your output may ONLY be: (1) what your character says, (2) what your character tries/does, or (3) a short question to the GM.",
  "- NEVER narrate the world, scenery, weather, NPC actions, or outcomes. The GM alone handles the world.",
  "- NEVER speak for other PCs or NPCs. NEVER invent what happens next.",
  "- Do not describe success/failure of attempts — declare the attempt and wait for the GM.",
  "- Do not invent dice rolls or mechanical outcomes.",
  "- Keep it to one or two short paragraphs of character speech/action only.",
].join("\n");

const GM_OVERLAY = [
  "RULE LAYER — You are the Game Master, but you are still yourself:",
  "- Run the table entirely in your persona's voice, tone, humor, vocabulary, and attitude.",
  "- Do not sound like a generic RPG narrator. If your persona is dry, warm, theatrical, terse, etc., the narration must feel like that person GMing.",
  "- Your job is still GM work: describe the world, portray NPCs, call for checks when stakes matter, keep continuity.",
  "- PCs only speak/act/ask; you alone narrate the world and resolve what happens.",
  "- Honor adventure seed facts; improvise freely between them. Never contradict the secret once established.",
  "- You are final arbiter of the world and soft house rules. PCs own their character voices.",
  "- Never invent dice results. To call a check, fill the <check> block; the server rolls.",
  "- Update <sceneSummary> to a short current-situation blurb (max ~500 chars).",
  "- Use clockDelta only when time/pressure meaningfully advances (integer, may be 0/omit).",
  "- Optional hpUpdates: JSON array [{\"participantId\":\"...\",\"hp\":number}].",
  "- Optional imagePrompt: a vivid visual description for a picture to show the party (scene, NPC, clue). Use sparingly for striking moments — leave empty most turns.",
  "- Soft house rules; D&D flavor only — not full 5e compliance.",
].join("\n");

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

  const system = [
    `You are ${participant.displayName}, and you are running this roleplaying table as GM.`,
    participant.persona.systemPrompt.trim(),
    "",
    GM_OVERLAY,
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
    "  <imagePrompt><![CDATA[]]></imagePrompt>",
    "</turn>",
    "Leave check fields and imagePrompt empty when unused. hpUpdates empty or JSON array.",
  ].join("\n");

  const user = [
    `Scene summary: ${rpg.sceneSummary}`,
    rpg.clock ? `Clock ${rpg.clock.name}: ${rpg.clock.value}/${rpg.clock.max}` : "Clock: none",
    rpg.lastRoll
      ? `Last roll: ${rpg.lastRoll.label} total ${rpg.lastRoll.total} vs ${rpg.lastRoll.dc} (${rpg.lastRoll.success ? "success" : "failure"})`
      : "Last roll: none",
    "",
    "Roster:",
    roster,
    "",
    formatRpgPromptMemory(state, 16),
    "",
    `Take your GM turn as ${participant.displayName} — stay in persona.`,
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

  return parseGmTurn(raw);
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
    participant.persona.systemPrompt.trim(),
    "",
    PC_OVERLAY,
    "",
    "Respond with XML only:",
    "<turn>",
    "  <content><![CDATA[only your character's speech, action attempt, or question to the GM]]></content>",
    "  <isAction>true|false</isAction>",
    "</turn>",
    "isAction=true when you attempt something physical/risky; false for dialogue or questions to the GM.",
    "Do not narrate the world in <content>.",
  ].join("\n");

  const user = [
    `Adventure: ${rpg.publicSeed.title} — ${rpg.publicSeed.premise}`,
    `Scene: ${rpg.sceneSummary}`,
    me ? `Your HP: ${me.hp}/${me.maxHp}; tags: ${me.tags.join(", ") || "(none)"}` : "Your vitals: unknown",
    rpg.lastRoll && rpg.lastRoll.participantId === participant.id
      ? `Your last check (${rpg.lastRoll.label}): ${rpg.lastRoll.success ? "success" : "failure"} (${rpg.lastRoll.total} vs DC ${rpg.lastRoll.dc})`
      : "",
    "",
    formatRpgPromptMemory(state, 16),
    "",
    `Your turn as ${participant.displayName}: speak, act, or ask the GM — do not narrate the world.`,
  ].join("\n");

  const raw = await ctx.complete({
    apiKey: ctx.apiKey,
    model: participant.persona.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.9,
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
