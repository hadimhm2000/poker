import { parseCards } from "./cards";
import { type CategoryKey, type Variant, evaluate5, showdown } from "./hand";
import type { Money } from "./money";

/**
 * The rules section: which situations exist, their card examples, and search. The words
 * live in the translations (rules.s.<id>.*); the examples here are checked by the hand
 * engine in tests, so the page and the bot can never contradict the calculator.
 */

export type RuleExample =
  /** A showdown: board plus each player's hole cards. */
  | { kind: "showdown"; variant: Variant; board: string; hands: { label: string; cards: string }[]; winners: string[] }
  /** Two or more finished five-card hands compared directly. */
  | { kind: "five"; hands: { label: string; cards: string }[]; winners: string[] };

export interface Situation {
  id: string;
  /** English search words, used in every language alongside the translated text. */
  tags: string[];
  example?: RuleExample;
}

export const SITUATIONS: readonly Situation[] = [
  {
    id: "boardPlays",
    tags: ["board", "split", "chop", "holdem"],
    example: {
      kind: "showdown",
      variant: "holdem",
      board: "As Kd Qh Jc Ts",
      hands: [
        { label: "A", cards: "2c 3d" },
        { label: "B", cards: "4h 5s" },
      ],
      winners: ["A", "B"],
    },
  },
  {
    id: "kicker",
    tags: ["kicker", "sixth", "card", "split"],
    example: {
      kind: "showdown",
      variant: "holdem",
      board: "Ah Ad Kc Ks Qd",
      hands: [
        { label: "A", cards: "Jc 2d" },
        { label: "B", cards: "Tc 3d" },
      ],
      winners: ["A", "B"],
    },
  },
  {
    id: "suits",
    tags: ["suit", "flush", "spades", "hearts", "split"],
    example: {
      kind: "showdown",
      variant: "holdem",
      board: "Ah Jh 8h 5h 3h",
      hands: [
        { label: "A", cards: "2c 2d" },
        { label: "B", cards: "4c 4d" },
      ],
      winners: ["A", "B"],
    },
  },
  {
    id: "threePairs",
    tags: ["two pair", "pair", "three pairs", "kicker"],
    example: {
      kind: "showdown",
      variant: "holdem",
      board: "Kh Kd 9c 9s 4d",
      hands: [
        { label: "A", cards: "Qc 4h" },
        { label: "B", cards: "Ac 2h" },
      ],
      winners: ["B"],
    },
  },
  {
    id: "fullHouses",
    tags: ["full house", "boat", "trips"],
    example: {
      kind: "five",
      hands: [
        { label: "A", cards: "9h 9d 9c 2s 2d" },
        { label: "B", cards: "8h 8d 8c As Ad" },
      ],
      winners: ["A"],
    },
  },
  {
    id: "twoFlushes",
    tags: ["flush", "high card"],
    example: {
      kind: "five",
      hands: [
        { label: "A", cards: "Ah Jh 8h 5h 3h" },
        { label: "B", cards: "Ad Jd 8d 4d 3d" },
      ],
      winners: ["A"],
    },
  },
  {
    id: "wheel",
    tags: ["straight", "ace", "wheel", "wrap"],
    example: {
      kind: "five",
      hands: [
        { label: "A", cards: "Ah 2d 3c 4s 5h" },
        { label: "B", cards: "Qh Kd Ac 2s 3h" },
      ],
      winners: ["A"],
    },
  },
  {
    id: "boardQuads",
    tags: ["quads", "four of a kind", "kicker", "holdem"],
    example: {
      kind: "showdown",
      variant: "holdem",
      board: "Ah Ad Ac As 5h",
      hands: [
        { label: "A", cards: "Kc 2d" },
        { label: "B", cards: "Qc 3d" },
      ],
      winners: ["A"],
    },
  },
  {
    id: "omahaFlush",
    tags: ["omaha", "plo", "flush", "hearts"],
    example: {
      kind: "showdown",
      variant: "omaha",
      board: "3h 7h 9h Jh 5c",
      hands: [
        { label: "A", cards: "Ah Kc Qd 2s" },
        { label: "B", cards: "2h 4h 6c 8d" },
      ],
      winners: ["B"],
    },
  },
  {
    id: "omahaStraight",
    tags: ["omaha", "plo", "straight"],
    example: {
      kind: "showdown",
      variant: "omaha",
      board: "5h 6d 7c 8s Kh",
      hands: [
        { label: "A", cards: "9c Kd Qs Jh" },
        { label: "B", cards: "9d Tc 2c 3h" },
      ],
      winners: ["B"],
    },
  },
  {
    id: "omahaQuads",
    tags: ["omaha", "plo", "quads", "aces", "full house"],
    example: {
      kind: "showdown",
      variant: "omaha",
      board: "Ah Ad Ac As 5h",
      hands: [
        { label: "A", cards: "Kc Kd 2s 3h" },
        { label: "B", cards: "Qc Jd Ts 9h" },
      ],
      winners: ["A"],
    },
  },
  { id: "showOrder", tags: ["showdown", "order", "show", "river", "all-in"] },
  { id: "cardsSpeak", tags: ["cards speak", "muck", "fold", "declare", "showdown"] },
  { id: "minRaise", tags: ["raise", "minimum", "bet"] },
  { id: "shortAllIn", tags: ["all-in", "raise", "reopen", "short"] },
  { id: "stringBet", tags: ["string", "verbal", "declare", "raise", "call"] },
  { id: "outOfTurn", tags: ["turn", "out of turn", "action"] },
  { id: "oddChip", tags: ["odd chip", "split", "button", "remainder"] },
  { id: "headsUp", tags: ["heads-up", "two players", "button", "blinds"] },
  { id: "sidePot", tags: ["side pot", "all-in", "pot"] },
];

/** One five-card example for every hand category, strongest first. */
export const HAND_EXAMPLES: readonly { key: CategoryKey; cards: string }[] = [
  { key: "royalFlush", cards: "As Ks Qs Js Ts" },
  { key: "straightFlush", cards: "9h 8h 7h 6h 5h" },
  { key: "quads", cards: "Qc Qd Qh Qs 7d" },
  { key: "fullHouse", cards: "Kh Kd Ks 4c 4d" },
  { key: "flush", cards: "Ad Jd 8d 5d 2d" },
  { key: "straight", cards: "Tc 9d 8h 7s 6c" },
  { key: "trips", cards: "7h 7d 7c Ks 2d" },
  { key: "twoPair", cards: "Jh Jc 5d 5s As" },
  { key: "pair", cards: "Th Td Ac 8s 4h" },
  { key: "highCard", cards: "Ah Qd 9c 6s 3h" },
];

/** The engine's answer for an example (used by tests and shown on the page). */
export function exampleWinners(ex: RuleExample): string[] {
  if (ex.kind === "five") {
    const scored = ex.hands.map((h) => ({ label: h.label, score: evaluate5(parseCards(h.cards)).score }));
    const top = Math.max(...scored.map((s) => s.score));
    return scored.filter((s) => s.score === top).map((s) => s.label);
  }
  return showdown(
    ex.variant,
    parseCards(ex.board),
    ex.hands.map((h) => ({ id: h.label, hole: parseCards(h.cards) })),
  ).winners;
}

const fold = (s: string) =>
  s
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // Persian and Arabic letters that look alike.
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\s\-_'’.,:;!?()«»"]+/g, " ")
    .trim();

/**
 * Find situations for a free-text query ("omaha flush", "کیکر"). Every word must appear in
 * the situation's id, tags or translated text. Returns ids, best match first.
 */
export function searchRules(query: string, text: (id: string) => string): string[] {
  const words = fold(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  const scored: { id: string; score: number }[] = [];
  for (const s of SITUATIONS) {
    const tags = fold(`${s.id} ${s.tags.join(" ")}`);
    const body = fold(text(s.id));
    let score = 0;
    let all = true;
    for (const w of words) {
      if (tags.includes(w)) score += 2;
      else if (body.includes(w)) score += 1;
      else all = false;
    }
    if (all) scored.push({ id: s.id, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.id);
}

/**
 * Pot-limit: the most a player may raise to. `pot` is everything in the middle including
 * bets already made this round; the raise may be as large as the pot after calling.
 */
export function potLimitMax(input: { pot: Money; currentBet: Money; alreadyIn: Money }): {
  toCall: Money;
  raiseTo: Money;
  putIn: Money;
} {
  const { pot, currentBet, alreadyIn } = input;
  for (const v of [pot, currentBet, alreadyIn]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error("amounts must be non-negative integers");
  }
  if (alreadyIn > currentBet) throw new Error("already in cannot exceed the current bet");
  const toCall = currentBet - alreadyIn;
  const raiseBy = pot + toCall;
  return { toCall, raiseTo: currentBet + raiseBy, putIn: toCall + raiseBy };
}
