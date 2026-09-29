import { type Money, assertNonNegative, sum } from "./money";
import { type Balance, type Transfer, balancesWithOpenDebts, settle } from "./settlement";

/** Stored status. "balanced" is derived from the numbers of a live game, not stored. */
export type StoredGameStatus = "draft" | "live" | "closed";
export type GameStatus = StoredGameStatus | "balanced";

export interface GameEntry {
  playerId: string;
  /** buy-in + all rebuys */
  totalIn: Money;
  /** null until the host enters it; 0 for a player who lost everything */
  cashOut: Money | null;
  /** Players who have an account and confirmed their own result. */
  confirmed?: boolean;
  /** true when this player is linked to a user account (only they can confirm). */
  hasAccount?: boolean;
}

export type CloseBlocker =
  | { code: "MIN_PLAYERS"; min: number; actual: number }
  | { code: "NO_BUY_IN"; playerIds: string[] }
  | { code: "MISSING_CASH_OUT"; playerIds: string[] }
  | { code: "UNBALANCED"; totalIn: Money; totalOut: Money; difference: Money }
  | { code: "UNCONFIRMED"; playerIds: string[] };

export interface CloseRules {
  /** Home setting: every player with an account must confirm before closing. */
  requireConfirmation: boolean;
}

export const MIN_PLAYERS = 2;

/** The same rules as the Excel sheet, enforced server side before a game may close. */
export function closeBlockers(entries: readonly GameEntry[], rules: CloseRules): CloseBlocker[] {
  for (const e of entries) {
    assertNonNegative(e.totalIn, `totalIn of ${e.playerId}`);
    if (e.cashOut !== null) assertNonNegative(e.cashOut, `cashOut of ${e.playerId}`);
  }
  const blockers: CloseBlocker[] = [];
  if (entries.length < MIN_PLAYERS) {
    blockers.push({ code: "MIN_PLAYERS", min: MIN_PLAYERS, actual: entries.length });
  }
  const noBuyIn = entries.filter((e) => e.totalIn <= 0).map((e) => e.playerId);
  if (noBuyIn.length) blockers.push({ code: "NO_BUY_IN", playerIds: noBuyIn });

  const missing = entries.filter((e) => e.cashOut === null).map((e) => e.playerId);
  if (missing.length) blockers.push({ code: "MISSING_CASH_OUT", playerIds: missing });

  const totalIn = sum(entries.map((e) => e.totalIn));
  const totalOut = sum(entries.map((e) => e.cashOut ?? 0));
  if (totalIn !== totalOut) {
    blockers.push({ code: "UNBALANCED", totalIn, totalOut, difference: totalOut - totalIn });
  }
  if (rules.requireConfirmation) {
    const unconfirmed = entries
      .filter((e) => e.hasAccount && !e.confirmed)
      .map((e) => e.playerId);
    if (unconfirmed.length) blockers.push({ code: "UNCONFIRMED", playerIds: unconfirmed });
  }
  return blockers;
}

/** Live games whose numbers balance show as "balanced"; any change drops them back to live. */
export function deriveStatus(
  stored: StoredGameStatus,
  entries: readonly GameEntry[],
  rules: CloseRules,
): GameStatus {
  if (stored !== "live") return stored;
  return closeBlockers(entries, rules).length === 0 ? "balanced" : "live";
}

export interface LiveTotals {
  pot: Money;
  cashedOut: Money;
  /** cashedOut − pot; zero when balanced */
  difference: Money;
}

export function liveTotals(entries: readonly GameEntry[]): LiveTotals {
  const pot = sum(entries.map((e) => e.totalIn));
  const cashedOut = sum(entries.map((e) => e.cashOut ?? 0));
  return { pot, cashedOut, difference: cashedOut - pot };
}

export function netResults(entries: readonly GameEntry[]): Balance[] {
  return entries.map((e) => ({ playerId: e.playerId, amount: (e.cashOut ?? 0) - e.totalIn }));
}

export interface ClosedGameResult {
  net: Balance[];
  transfers: Transfer[];
}

/**
 * Compute what closing produces: per-player net and the settlement transfers.
 * Throws if the game may not be closed, so callers cannot skip the checks.
 */
export function computeClose(
  entries: readonly GameEntry[],
  rules: CloseRules,
  openDebts: readonly Transfer[] = [],
): ClosedGameResult {
  const blockers = closeBlockers(entries, rules);
  if (blockers.length) {
    const err = new Error(`game cannot be closed: ${blockers.map((b) => b.code).join(", ")}`);
    (err as Error & { blockers: CloseBlocker[] }).blockers = blockers;
    throw err;
  }
  const net = netResults(entries);
  return { net, transfers: settle(balancesWithOpenDebts(net, openDebts)) };
}
