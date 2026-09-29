import { type Card, assertDistinct, cardToString } from "./cards";

export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  Trips = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  Quads = 7,
  StraightFlush = 8,
}

export const CATEGORY_KEYS = [
  "highCard",
  "pair",
  "twoPair",
  "trips",
  "straight",
  "flush",
  "fullHouse",
  "quads",
  "straightFlush",
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number] | "royalFlush";

/** Number of distinct 5-card hands in each category out of C(52,5) = 2,598,960. */
export const CATEGORY_COMBINATIONS: Record<CategoryKey, number> = {
  royalFlush: 4,
  straightFlush: 36,
  quads: 624,
  fullHouse: 3744,
  flush: 5108,
  straight: 10200,
  trips: 54912,
  twoPair: 123552,
  pair: 1098240,
  highCard: 1302540,
};

export interface HandValue {
  category: HandCategory;
  key: CategoryKey;
  /** Ranks compared in order after the category (e.g. trips rank, then kickers). */
  tiebreak: number[];
  /** Single comparable number; higher is better. */
  score: number;
  cards: Card[];
}

function scoreOf(category: number, tiebreak: number[]): number {
  let s = category;
  for (let i = 0; i < 5; i++) s = s * 15 + (tiebreak[i] ?? 0);
  return s;
}

/** Evaluate exactly five cards. */
export function evaluate5(cards: readonly Card[]): HandValue {
  if (cards.length !== 5) throw new Error("evaluate5 needs exactly 5 cards");
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0]!.suit);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Groups ordered by size, then rank: e.g. full house 9-9-9-2-2 → [[9,3],[2,2]]
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let straightHigh = 0;
  if (counts.size === 5) {
    if (ranks[0]! - ranks[4]! === 4) straightHigh = ranks[0]!;
    // The wheel A-2-3-4-5 is the lowest straight. No wrap-around (Q-K-A-2-3 is not one).
    else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5;
  }

  let category: HandCategory;
  let tiebreak: number[];
  if (straightHigh && flush) [category, tiebreak] = [HandCategory.StraightFlush, [straightHigh]];
  else if (groups[0]![1] === 4) [category, tiebreak] = [HandCategory.Quads, [groups[0]![0], groups[1]![0]]];
  else if (groups[0]![1] === 3 && groups[1]![1] === 2)
    [category, tiebreak] = [HandCategory.FullHouse, [groups[0]![0], groups[1]![0]]];
  else if (flush) [category, tiebreak] = [HandCategory.Flush, ranks];
  else if (straightHigh) [category, tiebreak] = [HandCategory.Straight, [straightHigh]];
  else if (groups[0]![1] === 3) [category, tiebreak] = [HandCategory.Trips, groups.map((g) => g[0])];
  else if (groups[0]![1] === 2 && groups[1]![1] === 2)
    [category, tiebreak] = [HandCategory.TwoPair, groups.map((g) => g[0])];
  else if (groups[0]![1] === 2) [category, tiebreak] = [HandCategory.Pair, groups.map((g) => g[0])];
  else [category, tiebreak] = [HandCategory.HighCard, ranks];

  const key: CategoryKey =
    category === HandCategory.StraightFlush && straightHigh === 14 ? "royalFlush" : CATEGORY_KEYS[category];
  return { category, key, tiebreak, score: scoreOf(category, tiebreak), cards: orderForDisplay(cards, groups, straightHigh) };
}

function orderForDisplay(cards: readonly Card[], groups: [number, number][], straightHigh: number): Card[] {
  const order = (r: number) => (straightHigh === 5 && r === 14 ? 1 : r);
  const groupIndex = new Map(groups.map(([r], i) => [r, i]));
  return [...cards].sort(
    (a, b) => groupIndex.get(a.rank)! - groupIndex.get(b.rank)! || order(b.rank) - order(a.rank),
  );
}

function* combinations<T>(items: readonly T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = start; i <= items.length - (k - acc.length); i++) {
    acc.push(items[i]!);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

function bestOf(candidates: Iterable<Card[]>): HandValue {
  let best: HandValue | null = null;
  for (const five of candidates) {
    const v = evaluate5(five);
    if (!best || v.score > best.score) best = v;
  }
  if (!best) throw new Error("not enough cards");
  return best;
}

export type Variant = "holdem" | "omaha";

/**
 * Best hand for a variant.
 * Hold'em: any 5 of hole + board (hole may be 0–2 cards, so "board plays" works).
 * Omaha: exactly 2 from the hand and exactly 3 from the board.
 */
export function bestHand(variant: Variant, hole: readonly Card[], board: readonly Card[]): HandValue {
  assertDistinct([...hole, ...board]);
  if (board.length > 5) throw new Error("board has at most 5 cards");
  if (variant === "holdem") {
    if (hole.length > 2) throw new Error("hold'em hands have 2 cards");
    return bestOf(combinations([...hole, ...board], 5));
  }
  if (hole.length < 4 || hole.length > 6) throw new Error("omaha hands have 4 to 6 cards");
  if (board.length < 3) throw new Error("omaha needs at least 3 board cards");
  return bestOf(
    (function* () {
      for (const two of combinations(hole, 2)) for (const three of combinations(board, 3)) yield [...two, ...three];
    })(),
  );
}

export interface ShowdownPlayer {
  id: string;
  hole: readonly Card[];
}

export interface ShowdownResult {
  winners: string[];
  hands: { id: string; value: HandValue }[];
  /** Why the winner beat the best losing hand: category, or the n-th tiebreak rank. */
  decidedBy: { kind: "category" } | { kind: "tiebreak"; index: number } | { kind: "tie" } | { kind: "uncontested" };
}

export function compareHands(a: HandValue, b: HandValue): number {
  return a.score - b.score;
}

export function showdown(variant: Variant, board: readonly Card[], players: readonly ShowdownPlayer[]): ShowdownResult {
  if (players.length === 0) throw new Error("no players");
  assertDistinct([...board, ...players.flatMap((p) => p.hole)]);
  const hands = players.map((p) => ({ id: p.id, value: bestHand(variant, p.hole, board) }));
  const top = Math.max(...hands.map((h) => h.value.score));
  const winners = hands.filter((h) => h.value.score === top).map((h) => h.id);
  const losers = hands.filter((h) => h.value.score !== top).sort((a, b) => b.value.score - a.value.score);
  let decidedBy: ShowdownResult["decidedBy"];
  if (hands.length === 1) decidedBy = { kind: "uncontested" };
  else if (!losers.length) decidedBy = { kind: "tie" };
  else {
    const w = hands.find((h) => h.value.score === top)!.value;
    const l = losers[0]!.value;
    if (w.category !== l.category) decidedBy = { kind: "category" };
    else {
      const index = w.tiebreak.findIndex((r, i) => r !== l.tiebreak[i]);
      decidedBy = { kind: "tiebreak", index };
    }
  }
  return { winners, hands, decidedBy };
}

export function describeHand(v: HandValue): string {
  return `${v.key} [${v.cards.map(cardToString).join(" ")}]`;
}
