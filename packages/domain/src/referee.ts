import { type Card, cardToString, parseCards } from "./cards";
import { type CategoryKey, type ShowdownResult, type Variant, showdown } from "./hand";
import { SITUATIONS, searchRules } from "./rules";

/**
 * The companion referee: a disputed showdown in a live game is typed in (board and hands) and
 * the hand engine gives the verdict, the reason, and the rule from the rules section that
 * covers it. The same function serves the website and the bot's /judge.
 */

export interface RulingInput {
  variant: Variant;
  /** The five board cards, e.g. "As Kd 7h 7c 2s". */
  board: string;
  /** Each hand with a label (a player's name or a number). */
  hands: { label: string; cards: string }[];
}

export interface RulingHand {
  label: string;
  cards: string[];
  key: CategoryKey;
  /** The best five cards, strongest first. */
  best: string[];
}

export interface Ruling {
  variant: Variant;
  board: string[];
  hands: RulingHand[];
  winners: string[];
  decidedBy: ShowdownResult["decidedBy"];
  /** Id of the matching situation on /rules (anchor #s-<id>), or null for the hand rankings. */
  situation: string | null;
}

export const MAX_RULING_HANDS = 10;

/** Validates and decides. Throws on bad cards, duplicates, wrong card counts or labels. */
export function judge(input: RulingInput): Ruling {
  const board = parseCards(input.board);
  if (board.length !== 5) throw new Error("the board needs five cards");
  if (input.hands.length < 2 || input.hands.length > MAX_RULING_HANDS) throw new Error("two to ten hands");
  const labels = input.hands.map((h, i) => h.label.trim().slice(0, 40) || String(i + 1));
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new Error("labels must differ");
  const holes = input.hands.map((h) => parseCards(h.cards));
  for (const h of holes) {
    if (input.variant === "holdem" && h.length !== 2) throw new Error("hold'em hands have 2 cards");
  }
  const result = showdown(
    input.variant,
    board,
    holes.map((hole, i) => ({ id: labels[i]!, hole })),
  );
  return {
    variant: input.variant,
    board: board.map(cardToString),
    hands: result.hands.map((h, i) => ({
      label: h.id,
      cards: holes[i]!.map(cardToString),
      key: h.value.key,
      best: h.value.cards.map(cardToString),
    })),
    winners: result.winners,
    decidedBy: result.decidedBy,
    situation: situationFor(input.variant, board, result),
  };
}

const KNOWN = new Set(SITUATIONS.map((s) => s.id));
const known = (id: string | undefined) => (id && KNOWN.has(id) ? id : null);

function rankCounts(cards: readonly Card[]) {
  const m = new Map<number, number>();
  for (const c of cards) m.set(c.rank, (m.get(c.rank) ?? 0) + 1);
  return m;
}

function maxSuit(cards: readonly Card[]) {
  const m = new Map<string, number>();
  for (const c of cards) m.set(c.suit, (m.get(c.suit) ?? 0) + 1);
  return Math.max(...m.values());
}

/** Four board cards inside any five-rank window (the ace also counts low). */
function fourToStraight(cards: readonly Card[]) {
  const ranks = new Set(cards.flatMap((c) => (c.rank === 14 ? [14, 1] : [c.rank])));
  for (let low = 1; low <= 10; low++) {
    let n = 0;
    for (let r = low; r < low + 5; r++) if (ranks.has(r)) n++;
    if (n >= 4) return true;
  }
  return false;
}

const isWheel = (h: { value: { key: CategoryKey; tiebreak: number[] } }) =>
  (h.value.key === "straight" || h.value.key === "straightFlush") && h.value.tiebreak[0] === 5;

/** Search words for the category that decided a close call. */
const CATEGORY_WORDS: Partial<Record<CategoryKey, string>> = {
  fullHouse: "full house",
  flush: "flush",
  straight: "straight",
  quads: "quads",
  twoPair: "two pair",
};

/** Which disputed situation from the rules table this showdown is an instance of. */
export function situationFor(variant: Variant, board: readonly Card[], r: ShowdownResult): string | null {
  const counts = [...rankCounts(board).values()];
  const top = r.hands.filter((h) => r.winners.includes(h.id));
  const w = top[0]!.value;

  if (variant === "omaha") {
    if (counts.includes(4)) return known("omahaQuads");
    if (maxSuit(board) >= 4) return known("omahaFlush");
    if (fourToStraight(board)) return known("omahaStraight");
    if (w.key === "flush") return known("omahaFlush");
    if (w.key === "straight") return known("omahaStraight");
    return null;
  }

  // "My spades beat your hearts": two equal flushes split, board or not.
  if (r.decidedBy.kind === "tie" && (w.key === "flush" || w.key === "straightFlush")) return known("suits");
  const boardSet = new Set(board.map(cardToString));
  if (r.decidedBy.kind === "tie" && top.every((h) => h.value.cards.every((c) => boardSet.has(cardToString(c))))) {
    return known("boardPlays");
  }
  if (counts.includes(4)) return known("boardQuads");
  if (r.hands.some(isWheel)) return known("wheel");
  if (r.decidedBy.kind === "tiebreak") {
    if (w.key === "twoPair" && counts.filter((n) => n >= 2).length >= 2) return known("threePairs");
    if (w.key === "fullHouse") return known("fullHouses");
    if (w.key === "flush") return known("twoFlushes");
    const words = CATEGORY_WORDS[w.key];
    const hit = words ? searchRules(words, () => "").find((id) => !id.startsWith("omaha")) : undefined;
    return known(hit) ?? known("kicker");
  }
  if (r.decidedBy.kind === "tie") return known("kicker");
  return null;
}

/** Link to the rule for a ruling (the hand rankings when no single situation applies). */
export function rulingAnchor(situation: string | null): string {
  return situation ? `#s-${situation}` : "#hands";
}
