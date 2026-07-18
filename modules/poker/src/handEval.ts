import { RANK_VALUE, type Card, type Rank } from "./cards.js";

export type HandRank =
  | "high_card"
  | "one_pair"
  | "two_pair"
  | "three_of_a_kind"
  | "straight"
  | "flush"
  | "full_house"
  | "four_of_a_kind"
  | "straight_flush";

export interface EvaluatedHand {
  rank: HandRank;
  rankValue: number;
  tiebreakers: number[];
  name: string;
}

const HAND_RANK_VALUE: Record<HandRank, number> = {
  high_card: 1,
  one_pair: 2,
  two_pair: 3,
  three_of_a_kind: 4,
  straight: 5,
  flush: 6,
  full_house: 7,
  four_of_a_kind: 8,
  straight_flush: 9,
};

function combinations(cards: Card[], k: number): Card[][] {
  const result: Card[][] = [];
  const n = cards.length;
  const idx = Array.from({ length: k }, (_, i) => i);

  const push = () => {
    result.push(idx.map((i) => cards[i]));
  };

  if (n < k) {
    return result;
  }

  push();
  while (true) {
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) {
      i -= 1;
    }
    if (i < 0) {
      break;
    }
    idx[i] += 1;
    for (let j = i + 1; j < k; j += 1) {
      idx[j] = idx[j - 1] + 1;
    }
    push();
  }
  return result;
}

function isStraight(valuesDesc: number[]): number | null {
  const unique = [...new Set(valuesDesc)].sort((a, b) => b - a);
  if (unique.includes(14)) {
    unique.push(1);
  }
  for (let i = 0; i <= unique.length - 5; i += 1) {
    const window = unique.slice(i, i + 5);
    if (window[0] - window[4] === 4 && new Set(window).size === 5) {
      return window[0] === 14 && window[4] === 1 ? 5 : window[0];
    }
  }
  // A-5 wheel check already handled via ace-as-1
  return null;
}

function evaluateFive(cards: Card[]): EvaluatedHand {
  const values = cards.map((c) => RANK_VALUE[c.rank]).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const flush = suits.every((s) => s === suits[0]);
  const straightHigh = isStraight(values);

  const counts = new Map<number, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return b[0] - a[0];
  });

  const rankName = (r: Rank | number): string => {
    const map: Record<number, string> = {
      14: "Ace",
      13: "King",
      12: "Queen",
      11: "Jack",
      10: "Ten",
      9: "Nine",
      8: "Eight",
      7: "Seven",
      6: "Six",
      5: "Five",
      4: "Four",
      3: "Three",
      2: "Two",
      1: "Ace",
    };
    return map[typeof r === "number" ? r : RANK_VALUE[r]] ?? String(r);
  };

  if (flush && straightHigh !== null) {
    return {
      rank: "straight_flush",
      rankValue: HAND_RANK_VALUE.straight_flush,
      tiebreakers: [straightHigh],
      name: straightHigh === 14 ? "Royal flush" : `Straight flush, ${rankName(straightHigh)} high`,
    };
  }
  if (groups[0][1] === 4) {
    return {
      rank: "four_of_a_kind",
      rankValue: HAND_RANK_VALUE.four_of_a_kind,
      tiebreakers: [groups[0][0], groups[1][0]],
      name: `Four of a kind, ${rankName(groups[0][0])}s`,
    };
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return {
      rank: "full_house",
      rankValue: HAND_RANK_VALUE.full_house,
      tiebreakers: [groups[0][0], groups[1][0]],
      name: `Full house, ${rankName(groups[0][0])}s full of ${rankName(groups[1][0])}s`,
    };
  }
  if (flush) {
    return {
      rank: "flush",
      rankValue: HAND_RANK_VALUE.flush,
      tiebreakers: values,
      name: `Flush, ${rankName(values[0])} high`,
    };
  }
  if (straightHigh !== null) {
    return {
      rank: "straight",
      rankValue: HAND_RANK_VALUE.straight,
      tiebreakers: [straightHigh],
      name: `Straight, ${rankName(straightHigh)} high`,
    };
  }
  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((g) => g[0]);
    return {
      rank: "three_of_a_kind",
      rankValue: HAND_RANK_VALUE.three_of_a_kind,
      tiebreakers: [groups[0][0], ...kickers],
      name: `Three of a kind, ${rankName(groups[0][0])}s`,
    };
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const highPair = Math.max(groups[0][0], groups[1][0]);
    const lowPair = Math.min(groups[0][0], groups[1][0]);
    const kicker = groups[2][0];
    return {
      rank: "two_pair",
      rankValue: HAND_RANK_VALUE.two_pair,
      tiebreakers: [highPair, lowPair, kicker],
      name: `Two pair, ${rankName(highPair)}s and ${rankName(lowPair)}s`,
    };
  }
  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((g) => g[0]);
    return {
      rank: "one_pair",
      rankValue: HAND_RANK_VALUE.one_pair,
      tiebreakers: [groups[0][0], ...kickers],
      name: `Pair of ${rankName(groups[0][0])}s`,
    };
  }
  return {
    rank: "high_card",
    rankValue: HAND_RANK_VALUE.high_card,
    tiebreakers: values,
    name: `High card ${rankName(values[0])}`,
  };
}

function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  if (a.rankValue !== b.rankValue) {
    return a.rankValue - b.rankValue;
  }
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i += 1) {
    const av = a.tiebreakers[i] ?? 0;
    const bv = b.tiebreakers[i] ?? 0;
    if (av !== bv) {
      return av - bv;
    }
  }
  return 0;
}

export function evaluateBestHand(cards: Card[]): EvaluatedHand {
  if (cards.length < 5) {
    throw new Error("Need at least 5 cards to evaluate a poker hand");
  }
  if (cards.length === 5) {
    return evaluateFive(cards);
  }
  let best: EvaluatedHand | null = null;
  for (const five of combinations(cards, 5)) {
    const hand = evaluateFive(five);
    if (!best || compareHands(hand, best) > 0) {
      best = hand;
    }
  }
  if (!best) {
    throw new Error("Failed to evaluate hand");
  }
  return best;
}

export function compareEvaluated(a: EvaluatedHand, b: EvaluatedHand): number {
  return compareHands(a, b);
}
