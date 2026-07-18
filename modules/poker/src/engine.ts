import type { Participant, ParticipantId } from "@llm-table/shared";
import { createDeck, shuffle } from "./cards.js";
import { compareEvaluated, evaluateBestHand } from "./handEval.js";
import {
  DEFAULT_BIG_BLIND,
  DEFAULT_SMALL_BLIND,
  DEFAULT_STACK,
  gloatQueue,
  type PokerPlayerState,
  type PokerPlayerStatus,
  type PokerSidePot,
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

/** Still in the current hand (not folded / eliminated). */
function contenders(poker: PokerState): PokerPlayerState[] {
  return poker.players.filter((p) => p.status === "active" || p.status === "allIn");
}

function activeCanAct(poker: PokerState): PokerPlayerState[] {
  return poker.players.filter((p) => p.status === "active");
}

function playersWithChips(poker: PokerState): PokerPlayerState[] {
  return poker.players.filter((p) => p.stack > 0);
}

/** Next seat with chips, walking forward from fromIndex (exclusive). */
function nextInChipIndex(players: PokerPlayerState[], fromIndex: number): number {
  const n = players.length;
  for (let offset = 1; offset <= n; offset += 1) {
    const idx = (fromIndex + offset) % n;
    if (players[idx].stack > 0) {
      return idx;
    }
  }
  throw new Error("No players with chips remaining");
}

/** After a pot is awarded, anyone at 0 chips is eliminated from the table. */
function markBustedPlayersOut(poker: PokerState): void {
  for (const p of poker.players) {
    if (p.stack <= 0) {
      p.stack = 0;
      p.status = "out";
      p.holeCards = [];
      p.betThisStreet = 0;
      p.hasActedThisStreet = true;
    }
  }
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

/**
 * Build main + side pots for the current hand.
 *
 * Side pots are created only when someone is all-in for less than the max
 * contribution. Unequal live bets (blinds, facing a raise) stay one pot.
 * Folded players still fund pots but cannot win them.
 */
export function calculateSidePots(players: PokerPlayerState[]): PokerSidePot[] {
  const total = players.reduce((sum, p) => sum + p.contributed, 0);
  if (total <= 0) {
    return [];
  }

  const contenderIds = players
    .filter((p) => p.status === "active" || p.status === "allIn")
    .map((p) => p.participantId);
  if (contenderIds.length === 0) {
    return [];
  }

  const maxContrib = Math.max(...players.map((p) => p.contributed), 0);
  const shortAllInLevels = [
    ...new Set(
      players
        .filter((p) => p.status === "allIn" && p.contributed > 0 && p.contributed < maxContrib)
        .map((p) => p.contributed),
    ),
  ].sort((a, b) => a - b);

  // No short all-in → a single pot (even if contributions differ mid-street).
  if (shortAllInLevels.length === 0) {
    return [{ amount: total, eligibleParticipantIds: contenderIds }];
  }

  const levels = [...new Set([...shortAllInLevels, maxContrib])].sort((a, b) => a - b);
  const pots: PokerSidePot[] = [];
  let prev = 0;
  for (const level of levels) {
    const amount = players.reduce((sum, p) => {
      const slice = Math.max(0, Math.min(p.contributed, level) - prev);
      return sum + slice;
    }, 0);
    const eligibleParticipantIds = players
      .filter(
        (p) =>
          (p.status === "active" || p.status === "allIn") && p.contributed >= level,
      )
      .map((p) => p.participantId);
    if (amount > 0 && eligibleParticipantIds.length > 0) {
      pots.push({ amount, eligibleParticipantIds });
    }
    prev = level;
  }
  return pots;
}

/** Seat order starting left of the dealer (for odd-chip splits). */
function idsInDealerOrder(
  poker: PokerState,
  ids: ParticipantId[],
): ParticipantId[] {
  const want = new Set(ids);
  const ordered: ParticipantId[] = [];
  const n = poker.players.length;
  for (let offset = 1; offset <= n; offset += 1) {
    const idx = (poker.dealerSeatIndex + offset) % n;
    const id = poker.players[idx].participantId;
    if (want.has(id)) {
      ordered.push(id);
    }
  }
  return ordered;
}

function potLabel(index: number, total: number): string {
  if (total <= 1) {
    return "Pot";
  }
  return index === 0 ? "Main pot" : `Side pot ${index}`;
}

function mergeWinnersByPlayer(winners: PokerWinner[]): PokerWinner[] {
  const merged = new Map<ParticipantId, PokerWinner>();
  for (const w of winners) {
    const existing = merged.get(w.participantId);
    if (!existing) {
      merged.set(w.participantId, { ...w });
      continue;
    }
    existing.amount += w.amount;
    const labels = [existing.potLabel, w.potLabel].filter(Boolean);
    if (labels.length > 0) {
      existing.potLabel = labels.join(", ");
    }
    if (existing.handName !== w.handName) {
      existing.handName = `${existing.handName}; ${w.handName}`;
    }
  }
  return [...merged.values()];
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
    pendingGloatIds: [],
    awaitingNextHand: false,
    lastActionSummary: null,
  };
}

export function startNewHand(poker: PokerState): PokerState {
  const players: PokerPlayerState[] = poker.players.map((p) => {
    const out = p.stack <= 0;
    const status: PokerPlayerStatus = out ? "out" : "active";
    return {
      ...p,
      stack: out ? 0 : p.stack,
      holeCards: [],
      betThisStreet: 0,
      contributed: 0,
      status,
      hasActedThisStreet: out,
    };
  });

  const withChips = players.filter((p) => p.stack > 0);
  if (withChips.length < 2) {
    return {
      ...poker,
      street: "betweenHands",
      deck: [],
      communityCards: [],
      pot: 0,
      currentBet: 0,
      minRaise: poker.bigBlind,
      winners: [],
      pendingGloatIds: [],
      awaitingNextHand: false,
      lastActionSummary: "Not enough chips to continue",
      handNumber: poker.handNumber,
      players,
      actingParticipantId: null,
    };
  }

  const dealer =
    poker.handNumber === 0
      ? players.findIndex((p) => p.stack > 0)
      : nextInChipIndex(players, poker.dealerSeatIndex);

  const inCount = withChips.length;
  const sbIndex = inCount === 2 ? dealer : nextInChipIndex(players, dealer);
  const bbIndex = inCount === 2 ? nextInChipIndex(players, dealer) : nextInChipIndex(players, sbIndex);

  const next: PokerState = {
    ...poker,
    street: "preflop",
    deck: shuffle(createDeck()),
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: poker.bigBlind,
    winners: [],
    pendingGloatIds: [],
    awaitingNextHand: false,
    lastActionSummary: null,
    handNumber: poker.handNumber + 1,
    dealerSeatIndex: dealer,
    players,
    actingParticipantId: null,
  };

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

  commitChips(next.players[sbIndex], next.smallBlind, next);
  commitChips(next.players[bbIndex], next.bigBlind, next);
  next.currentBet = Math.max(
    next.players[sbIndex].betThisStreet,
    next.players[bbIndex].betThisStreet,
  );
  next.minRaise = next.bigBlind;

  // Heads-up: dealer/SB acts first preflop. Otherwise: first in-chip seat after BB.
  const firstIndex = inCount === 2 ? dealer : nextInChipIndex(next.players, bbIndex);
  let acting = firstIndex;
  for (let i = 0; i < next.players.length; i += 1) {
    if (next.players[acting].status === "active") {
      break;
    }
    acting = nextInChipIndex(next.players, acting);
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

function awardWinnings(poker: PokerState, winners: PokerWinner[]): void {
  const merged = mergeWinnersByPlayer(winners);
  for (const w of merged) {
    playerById(poker, w.participantId).stack += w.amount;
  }
  poker.winners = merged;
  poker.pendingGloatIds = merged.map((w) => w.participantId);
  poker.awaitingNextHand = false;
  poker.pot = 0;
  poker.actingParticipantId = null;
  poker.street = "betweenHands";
  markBustedPlayersOut(poker);
}

function resolveShowdown(poker: PokerState): void {
  const alive = contenders(poker);
  if (alive.length === 0) {
    throw new Error("Showdown with no contenders");
  }

  if (alive.length === 1) {
    awardWinnings(poker, [
      {
        participantId: alive[0].participantId,
        amount: poker.pot,
        handName: "Won uncontested",
        potLabel: "Pot",
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

  const handById = new Map(
    alive.map((p) => [
      p.participantId,
      evaluateBestHand([...p.holeCards, ...poker.communityCards]),
    ]),
  );

  const pots = calculateSidePots(poker.players);
  if (pots.length === 0) {
    awardWinnings(poker, [
      {
        participantId: alive[0].participantId,
        amount: poker.pot,
        handName: handById.get(alive[0].participantId)?.name ?? "Showdown",
        potLabel: "Pot",
      },
    ]);
    poker.lastActionSummary = "Showdown";
    return;
  }

  const potTotal = pots.reduce((sum, p) => sum + p.amount, 0);
  if (potTotal !== poker.pot) {
    throw new Error(
      `Side pot total ${potTotal} does not match table pot ${poker.pot}`,
    );
  }

  const winners: PokerWinner[] = [];
  for (let potIndex = 0; potIndex < pots.length; potIndex += 1) {
    const pot = pots[potIndex];
    const label = potLabel(potIndex, pots.length);
    const eligible = pot.eligibleParticipantIds.filter((id) => handById.has(id));
    if (eligible.length === 0) {
      throw new Error(`${label} has no eligible showdown hands`);
    }
    if (eligible.length === 1) {
      winners.push({
        participantId: eligible[0],
        amount: pot.amount,
        handName:
          handById.get(eligible[0])?.name ??
          (alive.length === 1 ? "Won uncontested" : "Uncontested"),
        potLabel: label,
      });
      continue;
    }

    const scored = eligible.map((id) => ({
      id,
      hand: handById.get(id)!,
    }));
    scored.sort((a, b) => compareEvaluated(b.hand, a.hand));
    const best = scored[0].hand;
    const tied = scored.filter((s) => compareEvaluated(s.hand, best) === 0);
    const tiedIds = idsInDealerOrder(
      poker,
      tied.map((t) => t.id),
    );
    const share = Math.floor(pot.amount / tiedIds.length);
    let remainder = pot.amount - share * tiedIds.length;
    for (const id of tiedIds) {
      const odd = remainder > 0 ? 1 : 0;
      if (odd) {
        remainder -= 1;
      }
      winners.push({
        participantId: id,
        amount: share + odd,
        handName: handById.get(id)!.name,
        potLabel: label,
      });
    }
  }

  awardWinnings(poker, winners);
  const summary = winners
    .map((w) => `${w.potLabel ?? "Pot"}: ${w.handName}`)
    .join(" · ");
  poker.lastActionSummary = `Showdown — ${summary}`;
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
  // Short all-ins do not clear hasActedThisStreet; those players may only call/fold.
  const canBet =
    poker.currentBet === 0 && player.stack > 0 && !player.hasActedThisStreet;
  const canRaise =
    poker.currentBet > 0 &&
    maxRaiseTo > poker.currentBet &&
    !player.hasActedThisStreet;

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
      next.lastActionSummary =
        player.stack === 0
          ? `calls ${legal.callAmount} all-in`
          : `calls ${legal.callAmount}`;
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
      const prevMinRaise = next.minRaise;
      commitChips(player, add, next);
      if (player.betThisStreet > prevBet) {
        const raiseSize = player.betThisStreet - prevBet;
        next.currentBet = player.betThisStreet;
        // Short all-in (< full min-raise) does not reopen action for players who already acted.
        const fullOpen = prevBet === 0 || raiseSize >= prevMinRaise;
        if (fullOpen) {
          next.minRaise = Math.max(next.bigBlind, raiseSize);
          for (const p of next.players) {
            if (p.participantId !== actorId && p.status === "active") {
              p.hasActedThisStreet = false;
            }
          }
        }
      }
      player.hasActedThisStreet = true;
      const allInNote = player.stack === 0 ? " all-in" : "";
      next.lastActionSummary =
        action === "bet"
          ? `bets ${player.betThisStreet}${allInNote}`
          : `raises to ${player.betThisStreet}${allInNote}`;
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
  if (playersWithChips(poker).length < 2) {
    return poker;
  }
  return startNewHand(poker);
}

/** Deal the next hand after the between-hands review pause. */
export function continueToNextHand(poker: PokerState): PokerState {
  if (poker.street !== "betweenHands") {
    throw new Error("Can only deal the next hand between hands");
  }
  if (gloatQueue(poker).length > 0) {
    throw new Error("Winners are still taking their celebration beat");
  }
  if (!poker.awaitingNextHand) {
    throw new Error("Table is not waiting for a next-hand confirmation");
  }
  if (playersWithChips(poker).length < 2) {
    throw new Error("Not enough chips to deal another hand");
  }
  return startNewHand({ ...poker, awaitingNextHand: false });
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
