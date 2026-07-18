import type { ClientAction, TurnGenerationContext } from "@llm-table/shared";
import { extractXmlTag, requireXmlTag } from "@llm-table/shared";
import { formatCards } from "./cards.js";
import { legalActions } from "./engine.js";
import { gloatQueue, isPokerState } from "./types.js";

const POKER_RULES_OVERLAY = [
  "RULE LAYER — Texas Hold'em (this is layered on top of your persona; stay in character):",
  "- You are playing No-Limit Texas Hold'em at this table.",
  "- On your turn you must choose a legal action: fold, check, call, bet, or raise.",
  "- Also say something at the table (tableTalk): banter, reaction, or smalltalk is encouraged — not only the move.",
  "- Keep tableTalk short (one or two sentences). No stage directions.",
  "- NEVER reveal your actual hole cards in tableTalk — not by rank, suit, or exact hand. Vague bluffs and misdirection are fine; naming the real cards is not.",
  "- Do not invent illegal actions. Prefer natural human play: sometimes loose chat, sometimes quiet.",
].join("\n");

const POKER_GLOAT_OVERLAY = [
  "RULE LAYER — Texas Hold'em (post-hand celebration):",
  "- You just won (or chopped) the pot. You get one short spoken beat before the next hand.",
  "- Stay in character: gloat, shrug, tip the hat, needle someone, or celebrate however this persona would.",
  "- Keep it to one or two sentences. No stage directions.",
  "- Do not name your hole cards in chat (rank, suit, or exact holdings). React to the win without listing what you held.",
].join("\n");

interface LlmPokerDecision {
  tableTalk: string;
  action: "fold" | "check" | "call" | "bet" | "raise";
  raiseTo?: number;
}

function parseDecision(raw: string, legal: ReturnType<typeof legalActions>): LlmPokerDecision {
  const tableTalk = requireXmlTag(raw, "tableTalk");
  const actionRaw = requireXmlTag(raw, "action").toLowerCase();
  const raiseRaw = extractXmlTag(raw, "raiseTo") ?? "";

  if (
    actionRaw !== "fold" &&
    actionRaw !== "check" &&
    actionRaw !== "call" &&
    actionRaw !== "bet" &&
    actionRaw !== "raise"
  ) {
    throw new Error(`Invalid poker action: ${actionRaw}`);
  }
  const action = actionRaw;

  let raiseTo: number | undefined;
  if (raiseRaw.length > 0) {
    const n = Number(raiseRaw);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid raiseTo: ${raiseRaw}`);
    }
    raiseTo = n;
  }

  if (action === "check" && !legal.canCheck) {
    if (legal.canCall) {
      return { tableTalk, action: "call" };
    }
    return { tableTalk, action: "fold" };
  }
  if (action === "call" && !legal.canCall) {
    if (legal.canCheck) {
      return { tableTalk, action: "check" };
    }
    throw new Error("Model chose call but call is illegal");
  }
  if (action === "bet" && !legal.canBet) {
    if (legal.canRaise) {
      return { tableTalk, action: "raise", raiseTo: raiseTo ?? legal.minRaiseTo };
    }
    throw new Error("Model chose bet but bet is illegal");
  }
  if (action === "raise" && !legal.canRaise) {
    if (legal.canCall) {
      return { tableTalk, action: "call" };
    }
    if (legal.canCheck) {
      return { tableTalk, action: "check" };
    }
    return { tableTalk, action: "fold" };
  }

  return { tableTalk, action, raiseTo };
}

async function generateWinnerGloat(ctx: TurnGenerationContext): Promise<ClientAction> {
  const { participant, state } = ctx;
  if (!participant.persona) {
    throw new Error(`${participant.displayName} has no persona definition`);
  }
  if (!isPokerState(state.moduleState)) {
    throw new Error("Poker moduleState missing");
  }
  const poker = state.moduleState;
  const myWins = poker.winners.filter((w) => w.participantId === participant.id);
  if (myWins.length === 0) {
    throw new Error(`${participant.displayName} has no win to celebrate`);
  }

  const winLines = myWins
    .map((w) => `${w.amount} chips (${w.handName})`)
    .join("; ");
  const allWinners = poker.winners
    .map((w) => {
      const name =
        state.participants.find((p) => p.id === w.participantId)?.displayName ?? w.participantId;
      return `- ${name}: ${w.amount} chips — ${w.handName}`;
    })
    .join("\n");

  const system = [
    participant.persona.systemPrompt,
    "",
    POKER_GLOAT_OVERLAY,
    "",
    "Respond with XML only (no markdown fences, no commentary outside tags):",
    "<turn>",
    "  <tableTalk><![CDATA[your spoken line]]></tableTalk>",
    "</turn>",
  ].join("\n");

  const user = [
    `Hand #${poker.handNumber} is over.`,
    `Result: ${poker.lastActionSummary ?? "pot awarded"}`,
    `You collected: ${winLines}`,
    `Board: ${poker.communityCards.length ? formatCards(poker.communityCards) : "(none)"}`,
    "",
    "Winners:",
    allWinners,
    "",
    "Recent table talk:",
    state.messages
      .slice(-12)
      .map((m) => `${m.displayName}: ${m.content}`)
      .join("\n") || "(quiet)",
    "",
    "Take your celebration beat.",
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

  const tableTalk = requireXmlTag(raw, "tableTalk").trim();
  if (!tableTalk) {
    throw new Error("Winner gloat returned empty tableTalk");
  }

  return { type: "chat.say", content: tableTalk };
}

export async function generatePokerLlmTurn(ctx: TurnGenerationContext): Promise<ClientAction> {
  const { participant, state } = ctx;
  if (!participant.persona) {
    throw new Error(`${participant.displayName} has no persona definition`);
  }
  if (!isPokerState(state.moduleState)) {
    throw new Error("Poker moduleState missing");
  }
  const poker = state.moduleState;

  if (
    poker.street === "betweenHands" &&
    gloatQueue(poker)[0] === participant.id
  ) {
    return generateWinnerGloat(ctx);
  }

  const me = poker.players.find((p) => p.participantId === participant.id);
  if (!me) {
    throw new Error("Persona is not seated in this poker hand");
  }
  const legal = legalActions(poker, participant.id);

  const roster = state.participants
    .map((p) => {
      const ps = poker.players.find((x) => x.participantId === p.id);
      const status = ps?.status ?? "?";
      return `- ${p.displayName} (stack ${ps?.stack ?? "?"}, status ${status}, bet ${ps?.betThisStreet ?? 0})`;
    })
    .join("\n");

  const system = [
    participant.persona.systemPrompt,
    "",
    POKER_RULES_OVERLAY,
    "",
    "Respond with XML only (no markdown fences, no commentary outside tags):",
    "<turn>",
    "  <tableTalk><![CDATA[your spoken line]]></tableTalk>",
    "  <action>fold|check|call|bet|raise</action>",
    "  <raiseTo></raiseTo>",
    "</turn>",
    "Use CDATA for tableTalk. For bet/raise, put in raiseTo your total chips committed this street after the action; leave raiseTo empty otherwise.",
  ].join("\n");

  const user = [
    `Street: ${poker.street}`,
    `Pot: ${poker.pot}`,
    `Current bet to match: ${poker.currentBet}`,
    `Your hole cards: ${formatCards(me.holeCards)}`,
    `Community: ${poker.communityCards.length ? formatCards(poker.communityCards) : "(none)"}`,
    `Your stack: ${me.stack}; your bet this street: ${me.betThisStreet}`,
    `Legal: check=${legal.canCheck}, call=${legal.canCall} (amount ${legal.callAmount}), bet=${legal.canBet}, raise=${legal.canRaise}, minRaiseTo=${legal.minRaiseTo}, maxRaiseTo=${legal.maxRaiseTo}`,
    "",
    "Players:",
    roster,
    "",
    "Recent table talk:",
    state.messages
      .slice(-12)
      .map((m) => `${m.displayName}: ${m.content}`)
      .join("\n") || "(quiet)",
    "",
    "Take your turn.",
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

  const decision = parseDecision(raw, legal);
  let raiseTo = decision.raiseTo;
  if (decision.action === "bet" || decision.action === "raise") {
    raiseTo = Math.min(
      Math.max(raiseTo ?? legal.minRaiseTo, legal.minRaiseTo),
      legal.maxRaiseTo,
    );
  }

  return {
    type: "poker.act",
    action: decision.action,
    raiseTo,
    tableTalk: decision.tableTalk,
  };
}
