import type { Card } from "./cards.js";
import { type Variant, showdown } from "./hand.js";
import { type Money, assertNonNegative, sum } from "./money.js";

export interface PotPlayer {
  id: string;
  /** Total chips this player put in during the hand. */
  contributed: Money;
  folded: boolean;
}

export interface Pot {
  /** 0 = main pot, 1.. = side pots */
  index: number;
  amount: Money;
  /** Non-folded players who covered this level. */
  eligible: string[];
  /** Level (cumulative per-player cap) this pot goes up to. */
  cap: Money;
  /**
   * true when only one player is eligible: nobody called that part, so it simply
   * goes back to them rather than being "won".
   */
  uncalled: boolean;
}

/**
 * Split contributions into a main pot and side pots.
 *
 * 1. Sort the distinct amounts of non-folded players low→high: these are the levels.
 * 2. Each pot collects, from every player (folded included), what they put in between the
 *    previous level and this one.
 * 3. Eligible for a pot: non-folded players who put in at least that level.
 * Folded money above the top level (rare) is dead money added to the last pot.
 * Invariant: sum of pots === sum of contributions.
 */
export function buildPots(players: readonly PotPlayer[]): Pot[] {
  const ids = new Set<string>();
  for (const p of players) {
    assertNonNegative(p.contributed, `contribution of ${p.id}`);
    if (ids.has(p.id)) throw new Error(`duplicate player ${p.id}`);
    ids.add(p.id);
  }
  const active = players.filter((p) => !p.folded);
  if (active.length === 0) throw new Error("at least one player must not have folded");

  const levels = [...new Set(active.map((p) => p.contributed))].filter((l) => l > 0).sort((a, b) => a - b);
  if (levels.length === 0) levels.push(0);

  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    const amount = sum(players.map((p) => Math.max(0, Math.min(p.contributed, level) - prev)));
    const eligible = active.filter((p) => p.contributed >= level).map((p) => p.id);
    pots.push({ index: pots.length, amount, eligible, cap: level, uncalled: false });
    prev = level;
  }
  const dead = sum(players.map((p) => Math.max(0, p.contributed - prev)));
  pots[pots.length - 1]!.amount += dead;

  // A pot only one player covered is an uncalled bet returned to them (always the last pot).
  for (const pot of pots) pot.uncalled = pot.eligible.length === 1 && active.length > 1;
  return pots;
}

export interface Payout {
  playerId: string;
  amount: Money;
}

export interface AwardOptions {
  /** Seat order of all players at the table, clockwise. */
  seatOrder: readonly string[];
  /** id of the player on the button */
  button: string;
  /** Smallest chip that can be split; odd chips are handed out in this unit. Default 1. */
  chipUnit?: Money;
}

/**
 * Pay each pot to its winners. Ties split the pot; the odd chip(s) go one unit at a time to
 * the winners in seat order starting left of the button.
 */
export function awardPots(
  pots: readonly Pot[],
  winnersByPot: readonly (readonly string[])[],
  opts: AwardOptions,
): Payout[] {
  const unit = opts.chipUnit ?? 1;
  if (!Number.isSafeInteger(unit) || unit <= 0) throw new Error("chipUnit must be a positive integer");
  const buttonSeat = opts.seatOrder.indexOf(opts.button);
  if (buttonSeat < 0) throw new Error("button is not seated");
  const distanceFromButton = (id: string) => {
    const seat = opts.seatOrder.indexOf(id);
    if (seat < 0) throw new Error(`${id} is not seated`);
    return (seat - buttonSeat - 1 + opts.seatOrder.length) % opts.seatOrder.length;
  };

  const totals = new Map<string, Money>();
  const add = (id: string, amount: Money) => totals.set(id, (totals.get(id) ?? 0) + amount);
  for (const pot of pots) {
    const given = winnersByPot[pot.index];
    const winners = pot.uncalled ? pot.eligible : given;
    if (!winners || winners.length === 0) throw new Error(`pot ${pot.index} has no winner`);
    for (const w of winners) {
      if (!pot.eligible.includes(w)) throw new Error(`${w} is not eligible for pot ${pot.index}`);
    }
    const ordered = [...new Set(winners)].sort((a, b) => distanceFromButton(a) - distanceFromButton(b));
    const units = Math.floor(pot.amount / unit);
    const leftover = pot.amount - units * unit; // below one chip unit: goes with the odd chip
    const each = Math.floor(units / ordered.length);
    let odd = units - each * ordered.length;
    ordered.forEach((id, i) => {
      let amount = each * unit;
      if (odd > 0) {
        amount += unit;
        odd--;
      }
      if (i === 0) amount += leftover;
      add(id, amount);
    });
  }
  return [...totals.entries()].map(([playerId, amount]) => ({ playerId, amount }));
}

/** Decide every pot's winners from the cards (only eligible players compete for each pot). */
export function winnersFromCards(
  pots: readonly Pot[],
  variant: Variant,
  board: readonly Card[],
  holes: ReadonlyMap<string, readonly Card[]>,
): string[][] {
  return pots.map((pot) => {
    if (pot.uncalled) return [...pot.eligible];
    const players = pot.eligible.map((id) => {
      const hole = holes.get(id);
      if (!hole) throw new Error(`missing cards for ${id}`);
      return { id, hole };
    });
    return showdown(variant, board, players).winners;
  });
}

export interface SidePotResult {
  pots: Pot[];
  total: Money;
  payouts: Payout[];
  /** payout − contribution for every player */
  net: Payout[];
}

export function resolveHand(
  players: readonly PotPlayer[],
  winners: readonly (readonly string[])[],
  opts: AwardOptions,
): SidePotResult {
  const pots = buildPots(players);
  const payouts = awardPots(pots, winners, opts);
  const paid = new Map(payouts.map((p) => [p.playerId, p.amount]));
  return {
    pots,
    total: sum(pots.map((p) => p.amount)),
    payouts,
    net: players.map((p) => ({ playerId: p.id, amount: (paid.get(p.id) ?? 0) - p.contributed })),
  };
}
