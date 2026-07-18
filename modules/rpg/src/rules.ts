import type {
  AdventureSeed,
  ClientAction,
  Participant,
  ParticipantId,
  RulesEngine,
  TableState,
} from "@llm-table/shared";
import { rollD20 } from "./dice.js";
import {
  formatSeedForGm,
  publicSeedSummary,
} from "./seeds.js";
import {
  isRpgState,
  type RpgPartyMember,
  type RpgState,
} from "./types.js";
import { normalizeRpgState } from "./promptMemory.js";

export const DEFAULT_PC_HP = 12;

function requireRpg(state: TableState): RpgState {
  if (!isRpgState(state.moduleState)) {
    throw new Error("RPG moduleState is missing or invalid");
  }
  return normalizeRpgState(state.moduleState);
}

function requireParticipant(state: TableState, id: ParticipantId): Participant {
  const p = state.participants.find((x) => x.id === id);
  if (!p) {
    throw new Error(`Unknown participant: ${id}`);
  }
  return p;
}

function appendMessage(
  state: TableState,
  participantId: ParticipantId,
  content: string,
  extras?: { imageDataUrl?: string },
): TableState {
  const actor = requireParticipant(state, participantId);
  const imageDataUrl = extras?.imageDataUrl?.trim();
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: crypto.randomUUID(),
        participantId,
        displayName: actor.displayName,
        content,
        createdAt: new Date().toISOString(),
        ...(imageDataUrl ? { imageDataUrl } : {}),
      },
    ],
  };
}

export function buildInitialRpgState(
  participants: Participant[],
  seed: AdventureSeed,
): RpgState {
  const gm = participants.find((p) => p.tableRole === "gm");
  if (!gm) {
    throw new Error("RPG table requires a GM participant");
  }

  const party: RpgPartyMember[] = participants
    .filter((p) => p.tableRole !== "gm")
    .map((p) => ({
      participantId: p.id,
      hp: DEFAULT_PC_HP,
      maxHp: DEFAULT_PC_HP,
      tags: [],
    }));

  return {
    seedId: seed.id,
    publicSeed: publicSeedSummary(seed),
    adventure: seed,
    secret: seed.secret,
    sceneSummary: seed.premise,
    clock: seed.clock
      ? {
          name: seed.clock.name,
          value: seed.clock.start ?? 0,
          max: seed.clock.max,
        }
      : null,
    party,
    pendingCheck: null,
    lastRoll: null,
    preferGmNext: true,
    gmParticipantId: gm.id,
    transcriptSummary: "",
    summaryThroughMessageCount: 0,
    advance: { speakerId: null, mode: "idle" },
  };
}

export function onRpgStart(state: TableState): TableState {
  const rpg = requireRpg(state);
  const gm = state.participants.find((p) => p.id === rpg.gmParticipantId);
  const gmName = gm?.displayName ?? "GM";
  return {
    ...state,
    activeSpeakerId: rpg.gmParticipantId,
    statusMessage: `${rpg.publicSeed.title} — ${gmName} sets the scene`,
    error: null,
  };
}

/** Exposed for GM prompt assembly. */
export function gmSeedBriefing(rpg: RpgState): string {
  return formatSeedForGm(rpg.adventure);
}

function applyGmAction(state: TableState, action: Extract<ClientAction, { type: "rpg.gm" }>, actorId: ParticipantId): TableState {
  const actor = requireParticipant(state, actorId);
  if (actor.tableRole !== "gm") {
    throw new Error("Only the GM may submit rpg.gm actions");
  }
  if (state.phase !== "running" && state.phase !== "paused") {
    throw new Error(`Cannot GM while session phase is "${state.phase}"`);
  }

  const narration = action.narration.trim();
  if (!narration) {
    throw new Error("GM narration must not be empty");
  }

  let rpg: RpgState = { ...requireRpg(state), preferGmNext: false };
  if (action.sceneSummary?.trim()) {
    rpg = { ...rpg, sceneSummary: action.sceneSummary.trim().slice(0, 800) };
  }

  if (typeof action.clockDelta === "number" && rpg.clock) {
    const nextValue = Math.max(
      0,
      Math.min(rpg.clock.max, rpg.clock.value + Math.trunc(action.clockDelta)),
    );
    rpg = { ...rpg, clock: { ...rpg.clock, value: nextValue } };
  }

  if (action.hpUpdates && action.hpUpdates.length > 0) {
    const party = rpg.party.map((member) => {
      const update = action.hpUpdates!.find((u) => u.participantId === member.participantId);
      if (!update) {
        return member;
      }
      const hp = Math.max(0, Math.min(member.maxHp, Math.trunc(update.hp)));
      return { ...member, hp };
    });
    rpg = { ...rpg, party };
  }

  let withNarration = appendMessage(
    {
      ...state,
      phase: "running",
      moduleState: rpg,
      activeSpeakerId: null,
      error: null,
    },
    actorId,
    narration,
    action.imageDataUrl?.trim()
      ? { imageDataUrl: action.imageDataUrl.trim() }
      : undefined,
  );

  let statusMessage: string | null = action.imageDataUrl?.trim()
    ? `${actor.displayName} narrates (with a picture)`
    : `${actor.displayName} narrates`;

  if (action.check) {
    const target = requireParticipant(withNarration, action.check.participantId);
    if (target.tableRole === "gm") {
      throw new Error("Cannot call a check on the GM");
    }
    const dc = Math.trunc(action.check.dc);
    const modifier = Math.trunc(action.check.modifier);
    const label = action.check.label.trim() || "check";
    if (!Number.isFinite(dc) || !Number.isFinite(modifier)) {
      throw new Error("Check dc and modifier must be numbers");
    }

    const value = rollD20();
    const total = value + modifier;
    const success = total >= dc;
    const lastRoll = {
      sides: 20,
      value,
      modifier,
      total,
      dc,
      success,
      label,
      participantId: target.id,
    };

    rpg = {
      ...(withNarration.moduleState as RpgState),
      pendingCheck: null,
      lastRoll,
      preferGmNext: false,
    };

    const modLabel = modifier >= 0 ? `+${modifier}` : `${modifier}`;
    const rollLine = `🎲 ${target.displayName} — ${label}: d20=${value} ${modLabel} → ${total} vs DC ${dc} — ${success ? "success" : "failure"}`;

    withNarration = appendMessage(
      {
        ...withNarration,
        moduleState: rpg,
      },
      actorId,
      rollLine,
    );
    statusMessage = rollLine;
  } else {
    withNarration = {
      ...withNarration,
      moduleState: {
        ...(withNarration.moduleState as RpgState),
        pendingCheck: null,
      },
    };
  }

  return {
    ...withNarration,
    statusMessage,
  };
}

function applyPcSay(
  state: TableState,
  action: Extract<ClientAction, { type: "rpg.say" }>,
  actorId: ParticipantId,
): TableState {
  const actor = requireParticipant(state, actorId);
  if (actor.tableRole === "gm") {
    throw new Error("GM must use rpg.gm, not rpg.say");
  }
  if (state.phase !== "running" && state.phase !== "paused") {
    throw new Error(`Cannot act while session phase is "${state.phase}"`);
  }
  if (actor.kind === "llm" && state.activeSpeakerId !== actorId) {
    throw new Error("It is not this participant's turn");
  }

  const content = action.content.trim();
  if (!content) {
    throw new Error("Message content must not be empty");
  }

  const rpg = requireRpg(state);
  const line = action.isAction ? `*${content}*` : content;

  return appendMessage(
    {
      ...state,
      phase: "running",
      moduleState: { ...rpg, preferGmNext: true },
      activeSpeakerId: null,
      error: null,
      statusMessage: action.isAction
        ? `${actor.displayName} attempts something`
        : `${actor.displayName} speaks`,
    },
    actorId,
    line,
  );
}

export function createRpgRules(): RulesEngine {
  return {
    apply(state, action: ClientAction, actorId: ParticipantId): TableState {
      if (action.type === "rpg.gm") {
        return applyGmAction(state, action, actorId);
      }
      if (action.type === "rpg.say") {
        return applyPcSay(state, action, actorId);
      }
      if (action.type === "chat.say") {
        // Allow human rail comments as plain say mapped to rpg.say dialogue
        return applyPcSay(
          state,
          { type: "rpg.say", content: action.content, isAction: false },
          actorId,
        );
      }
      throw new Error(`Unsupported action: ${(action as { type: string }).type}`);
    },

    isActive(state) {
      return state.phase === "running";
    },
  };
}

export function redactRpgState(state: TableState, viewerId: ParticipantId | null): TableState {
  if (!isRpgState(state.moduleState)) {
    return state;
  }
  const viewer = viewerId ? state.participants.find((p) => p.id === viewerId) : null;
  if (viewer?.tableRole === "gm") {
    return state;
  }
  return {
    ...state,
    moduleState: {
      ...state.moduleState,
      secret: "",
      adventure: {
        ...state.moduleState.adventure,
        secret: "",
      },
    },
  };
}
