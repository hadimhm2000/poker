export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export const SUITS = ["s", "h", "d", "c"] as const;
export type RankChar = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];

export interface Card {
  /** 2..14, ace = 14 */
  rank: number;
  suit: Suit;
}

/** Parses "As", "Td", "10h", "9c" (case-insensitive rank, lowercase or uppercase suit). */
export function parseCard(text: string): Card {
  const t = text.trim();
  const m = /^(10|[2-9TJQKA])([shdc])$/i.exec(t);
  if (!m) throw new Error(`invalid card "${text}"`);
  const r = m[1]!.toUpperCase() === "10" ? "T" : m[1]!.toUpperCase();
  return { rank: RANKS.indexOf(r as RankChar) + 2, suit: m[2]!.toLowerCase() as Suit };
}

export function parseCards(text: string | readonly string[]): Card[] {
  const parts = typeof text === "string" ? text.trim().split(/[\s,]+/).filter(Boolean) : text;
  const cards = parts.map(parseCard);
  assertDistinct(cards);
  return cards;
}

export function cardToString(c: Card): string {
  return `${RANKS[c.rank - 2]}${c.suit}`;
}

export function assertDistinct(cards: readonly Card[]): void {
  const seen = new Set<string>();
  for (const c of cards) {
    const k = cardToString(c);
    if (seen.has(k)) throw new Error(`duplicate card ${k}`);
    seen.add(k);
  }
}

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
  return deck;
}
