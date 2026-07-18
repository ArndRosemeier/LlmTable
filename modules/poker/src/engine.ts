import type { Participant, ParticipantId } from "@llm-table/shared";
import { createDeck, shuffle } from "./cards.js";
import { compareEvaluated, evaluateBestHand } from "./handEval.js";
import {
  DEFAULT_BIG_BLIND,
  DEFAULT_SMALL_BLIND,
  DEFAULT_STACK,
  type PokerPlayerState,
  type PokerState,
  type PokerStreet,
  type PokerWinner,
} from "./types.js";

function sortedBySeat(participants: Participant[]): Participant[] {
  return [...participants].sort((a, b) => a.seatIndex - b.seatIndex);
}

function playerById(poker: PokerState, id: ParticipantId): PokerPlayerState {
  const p = poker.players.find((x) => x.participantId === id);
  if (!p) {
    throw new Error(`Unknown poker player: ${id}`);
  }
  return p;
}

function indexOfPlayer(poker: PokerState, id: ParticipantId): number {
  const idx = poker.players.findIndex((p) => p.participantId === id);
  if (idx < 0) {
    throw new Error(`Player not seated: ${id}`);
  }
  return idx;
}

export function nextActiveIndex(poker: PokerState, fromIndex: number): number | null {
  const n = poker.players.length;
  for (let offset = 1; offset <= n; offset += 1) {
    const idx = (fromIndex + offset) % n;
    if (poker.players[idx].status === "active") {
      return idx;
    }
  }
  return null;
}

function contenders(poker: PokerState): PokerPlayerState[] {
  return poker.players.filter((p) => p.status !== "folded");
}

function activeCanAct(poker: PokerState): PokerPlayerState[] {
  return poker.players.filter((p) => p.status === "active");
}

function bettingRoundComplete(poker: PokerState): boolean {
  const actors = activeCanAct(poker);
  if (actors.length === 0) {
    return true;
  }
  return actors.every(
    (p) => p.hasActedThisStreet && p.betThisStreet === poker.currentBet,
  );
}

function commitChips(player: PokerPlayerState, amount: number, poker: PokerState): void {
  const pay = Math.min(amount, player.stack);
  player.stack -= pay;
  player.betThisStreet += pay;
  player.contributed += pay;
  poker.pot += pay;
  if (player.stack === 0) {
    player.status = "allIn";
  }
}

export function createInitialPokerState(participants: Participant[]): PokerState {
  const seated = sortedBySeat(participants);
  if (seated.length < 2) {
    throw new Error("Texas Hold'em needs at least 2 players");
  }
  return {
    street: "betweenHands",
    deck: [],
    communityCards: [],
    pot: 0,
    dealerSeatIndex: 0,
    smallBlind: DEFAULT_SMALL_BLIND,
    bigBlind: DEFAULT_BIG_BLIND,
    currentBet: 0,
    minRaise: DEFAULT_BIG_BLIND,
    actingParticipantId: null,
    players: seated.map((p) => ({
      participantId: p.id,
      stack: DEFAULT_STACK,
      holeCards: [],
      betThisStreet: 0,
      contributed: 0,
      status: "active",
      hasActedThisStreet: false,
    })),
    handNumber: 0,
    winners: [],
    lastActionSummary: null,
  };
}

export function startNewHand(poker: PokerState): PokerState {
  const next: PokerState = {
    ...poker,
    street: "preflop",
    deck: shuffle(createDeck()),
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: poker.bigBlind,
    winners: [],
    lastActionSummary: null,
    handNumber: poker.handNumber + 1,
    dealerSeatIndex:
      poker.handNumber === 0 ? 0 : (poker.dealerSeatIndex + 1) % poker.players.length,
    players: poker.players.map((p) => ({
      ...p,
      holeCards: [],
      betThisStreet: 0,
      contributed: 0,
      status: p.stack > 0 ? "active" : "folded",
      hasActedThisStreet: false,
    })),
    actingParticipantId: null,
  };

  const withChips = next.players.filter((p) => p.stack > 0);
  if (withChips.length < 2) {
    return {
      ...next,
      street: "betweenHands",
      actingParticipantId: null,
      lastActionSummary: "Not enough chips to continue",
    };
  }

  for (let round = 0; round < 2; round += 1) {
    for (const p of next.players) {
      if (p.status === "active") {
        const card = next.deck.pop();
        if (!card) {
          throw new Error("Deck exhausted while dealing hole cards");
        }
        p.holeCards.push(card);
      }
    }
  }

  const n = next.players.length;
  const dealer = next.dealerSeatIndex;
  const sbIndex = n === 2 ? dealer : (dealer + 1) % n;
  const bbIndex = n === 2 ? (dealer + 1) % n : (dealer + 2) % n;

  commitChips(next.players[sbIndex], next.smallBlind, next);
  commitChips(next.players[bbIndex], next.bigBlind, next);
  next.currentBet = Math.max(
    next.players[sbIndex].betThisStreet,
    next.players[bbIndex].betThisStreet,
  );
  next.minRaise = next.bigBlind;

  const firstIndex = n === 2 ? dealer : (bbIndex + 1) % n;
  let acting = firstIndex;
  for (let i = 0; i < n; i += 1) {
    if (next.players[acting].status === "active") {
      break;
    }
    acting = (acting + 1) % n;
  }
  next.actingParticipantId = next.players[acting].participantId;
  next.lastActionSummary = `Hand #${next.handNumber} dealt. Blinds posted.`;
  return next;
}

function dealCommunity(poker: PokerState, count: number): void {
  if (!poker.deck.pop()) {
    throw new Error("Deck exhausted (burn)");
  }
  for (let i = 0; i < count; i += 1) {
    const card = poker.deck.pop();
    if (!card) {
      throw new Error("Deck exhausted (community)");
    }
    poker.communityCards.push(card);
  }
}

function resetStreetBets(poker: PokerState): void {
  poker.currentBet = 0;
  poker.minRaise = poker.bigBlind;
  for (const p of poker.players) {
    p.betThisStreet = 0;
    p.hasActedThisStreet = p.status !== "active";
  }
}

function setNextActorAfter(poker: PokerState, actorIndex: number): void {
  const next = nextActiveIndex(poker, actorIndex);
  poker.actingParticipantId = next === null ? null : poker.players[next].participantId;
}

function onlyOneContender(poker: PokerState): boolean {
  return contenders(poker).length === 1;
}

function awardPot(poker: PokerState, winners: PokerWinner[]): void {
  for (const w of winners) {
    playerById(poker, w.participantId).stack += w.amount;
  }
  poker.winners = winners;
  poker.pot = 0;
  poker.actingParticipantId = null;
  poker.street = "betweenHands";
}

function resolveShowdown(poker: PokerState): void {
  const alive = contenders(poker);
  if (alive.length === 1) {
    awardPot(poker, [
      {
        participantId: alive[0].participantId,
        amount: poker.pot,
        handName: "Won uncontested",
      },
    ]);
    poker.lastActionSummary = "Everyone else folded.";
    return;
  }

  while (poker.communityCards.length < 5) {
    if (poker.communityCards.length === 0) {
      dealCommunity(poker, 3);
    } else {
      dealCommunity(poker, 1);
    }
  }

  const scored = alive.map((p) => ({
    player: p,
    hand: evaluateBestHand([...p.holeCards, ...poker.communityCards]),
  }));
  scored.sort((a, b) => compareEvaluated(b.hand, a.hand));
  const best = scored[0].hand;
  const top = scored.filter((s) => compareEvaluated(s.hand, best) === 0);
  const share = Math.floor(poker.pot / top.length);
  const remainder = poker.pot - share * top.length;
  const winners: PokerWinner[] = top.map((t, i) => ({
    participantId: t.player.participantId,
    amount: share + (i === 0 ? remainder : 0),
    handName: t.hand.name,
  }));
  awardPot(poker, winners);
  poker.lastActionSummary = `Showdown: ${winners.map((w) => w.handName).join(" / ")}`;
}

function advanceStreet(poker: PokerState): void {
  if (onlyOneContender(poker)) {
    resolveShowdown(poker);
    return;
  }

  const order: PokerStreet[] = ["preflop", "flop", "turn", "river", "showdown"];
  const idx = order.indexOf(poker.street);
  if (idx < 0) {
    return;
  }

  const nextStreet = order[idx + 1];
  if (nextStreet === "showdown") {
    poker.street = "showdown";
    resolveShowdown(poker);
    return;
  }

  poker.street = nextStreet;
  if (nextStreet === "flop") {
    dealCommunity(poker, 3);
  } else {
    dealCommunity(poker, 1);
  }
  resetStreetBets(poker);

  const n = poker.players.length;
  let acting = (poker.dealerSeatIndex + 1) % n;
  for (let i = 0; i < n; i += 1) {
    if (poker.players[acting].status === "active") {
      poker.actingParticipantId = poker.players[acting].participantId;
      poker.lastActionSummary = `Dealing ${nextStreet}`;
      return;
    }
    acting = (acting + 1) % n;
  }

  while (poker.communityCards.length < 5) {
    if (poker.communityCards.length === 0) {
      dealCommunity(poker, 3);
    } else {
      dealCommunity(poker, 1);
    }
  }
  poker.street = "showdown";
  resolveShowdown(poker);
}

export function legalActions(
  poker: PokerState,
  actorId: ParticipantId,
): {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
} {
  const player = playerById(poker, actorId);
  const toCall = Math.max(0, poker.currentBet - player.betThisStreet);
  const canCheck = toCall === 0;
  const canCall = toCall > 0 && player.stack > 0;
  const callAmount = Math.min(toCall, player.stack);
  const maxRaiseTo = player.betThisStreet + player.stack;
  const minRaiseTo = Math.min(poker.currentBet + poker.minRaise, maxRaiseTo);
  const canBet = poker.currentBet === 0 && player.stack > 0;
  const canRaise = poker.currentBet > 0 && maxRaiseTo > poker.currentBet;

  return {
    canFold: true,
    canCheck,
    canCall,
    callAmount,
    canBet,
    canRaise,
    minRaiseTo,
    maxRaiseTo,
  };
}

export function applyPokerAction(
  poker: PokerState,
  actorId: ParticipantId,
  action: "fold" | "check" | "call" | "bet" | "raise",
  raiseTo?: number,
): PokerState {
  if (poker.actingParticipantId !== actorId) {
    throw new Error("Not this player's turn to act");
  }
  if (poker.street === "betweenHands" || poker.street === "showdown") {
    throw new Error(`Cannot act during ${poker.street}`);
  }

  const next: PokerState = structuredClone(poker);
  const player = playerById(next, actorId);
  if (player.status !== "active") {
    throw new Error("Player cannot act");
  }

  const legal = legalActions(next, actorId);
  const actorIndex = indexOfPlayer(next, actorId);

  switch (action) {
    case "fold": {
      player.status = "folded";
      player.hasActedThisStreet = true;
      next.lastActionSummary = "folds";
      break;
    }
    case "check": {
      if (!legal.canCheck) {
        throw new Error("Cannot check");
      }
      player.hasActedThisStreet = true;
      next.lastActionSummary = "checks";
      break;
    }
    case "call": {
      if (!legal.canCall) {
        throw new Error("Cannot call");
      }
      commitChips(player, legal.callAmount, next);
      player.hasActedThisStreet = true;
      next.lastActionSummary = `calls ${legal.callAmount}`;
      break;
    }
    case "bet":
    case "raise": {
      if (action === "bet" && !legal.canBet) {
        throw new Error("Cannot bet");
      }
      if (action === "raise" && !legal.canRaise) {
        throw new Error("Cannot raise");
      }
      if (typeof raiseTo !== "number" || !Number.isFinite(raiseTo)) {
        throw new Error("bet/raise requires raiseTo");
      }
      const target = Math.floor(raiseTo);
      if (target > legal.maxRaiseTo) {
        throw new Error("Raise exceeds stack");
      }
      if (target < legal.minRaiseTo && target !== legal.maxRaiseTo) {
        throw new Error(`Raise must be at least ${legal.minRaiseTo} (or all-in)`);
      }
      if (action === "raise" && target <= next.currentBet) {
        throw new Error("Raise must increase the bet");
      }
      const add = target - player.betThisStreet;
      if (add <= 0) {
        throw new Error("Invalid raise amount");
      }
      const prevBet = next.currentBet;
      commitChips(player, add, next);
      if (player.betThisStreet > prevBet) {
        next.minRaise = Math.max(next.minRaise, player.betThisStreet - prevBet);
        next.currentBet = player.betThisStreet;
        for (const p of next.players) {
          if (p.participantId !== actorId && p.status === "active") {
            p.hasActedThisStreet = false;
          }
        }
      }
      player.hasActedThisStreet = true;
      next.lastActionSummary =
        action === "bet" ? `bets ${player.betThisStreet}` : `raises to ${player.betThisStreet}`;
      break;
    }
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action ${_exhaustive}`);
    }
  }

  if (onlyOneContender(next)) {
    resolveShowdown(next);
    return next;
  }

  if (bettingRoundComplete(next)) {
    advanceStreet(next);
    return next;
  }

  setNextActorAfter(next, actorIndex);
  return next;
}

export function maybeStartNextHand(poker: PokerState): PokerState {
  if (poker.street !== "betweenHands") {
    return poker;
  }
  if (poker.players.filter((p) => p.stack > 0).length < 2) {
    return poker;
  }
  return startNewHand(poker);
}

export function redactPokerState(poker: PokerState, viewerId: ParticipantId | null): PokerState {
  const revealAll = poker.street === "betweenHands" || poker.street === "showdown";
  return {
    ...poker,
    deck: [],
    players: poker.players.map((p) => ({
      ...p,
      holeCards:
        revealAll || p.participantId === viewerId
          ? p.holeCards
          : [],
    })),
  };
}
