import { type Card, RANKS } from "@poker/domain";

const SUIT_SYMBOL = { s: "♠", h: "♥", d: "♦", c: "♣" } as const;

/** A playing card drawn with markup (no images), readable in both themes. */
export function PlayingCard({ card }: { card: Card }) {
  const rank = RANKS[card.rank - 2] === "T" ? "10" : RANKS[card.rank - 2];
  const red = card.suit === "h" || card.suit === "d";
  return (
    <span className={`playing-card${red ? " red" : ""}`} aria-label={`${rank}${card.suit}`}>
      <span>{rank}</span>
      <span className="suit">{SUIT_SYMBOL[card.suit]}</span>
    </span>
  );
}
