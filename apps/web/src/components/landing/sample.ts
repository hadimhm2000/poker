/**
 * One sample night, used by every fragment on the landing page so a fact shown twice is one
 * variable. It is illustrative data, not a customer. Nets sum to zero (checked below).
 */
export const SAMPLE_GAME = {
  number: 12,
  players: [
    { id: "a", name: "Ali", buyIn: 100, cashOut: 170 },
    { id: "b", name: "Sara", buyIn: 100, cashOut: 45 },
    { id: "c", name: "Max", buyIn: 100, cashOut: 70 },
    { id: "d", name: "Nina", buyIn: 100, cashOut: 115 },
  ],
} as const;

if (SAMPLE_GAME.players.reduce((n, p) => n + p.cashOut - p.buyIn, 0) !== 0) {
  throw new Error("landing sample does not balance");
}

export const nameOf = (id: string) => SAMPLE_GAME.players.find((p) => p.id === id)?.name ?? id;
