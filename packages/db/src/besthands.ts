import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Tx } from "./client";
import { DomainError } from "./repo";
import { bestHands, games, homes, players } from "./schema";

// Best hand (بهترین دست): royal flush, straight flush and four of a kind, recorded per
// game by the host and added up for the whole home. Same rule as repo.ts: every function
// runs inside asUser() and RLS is the backstop for each rule stated here.

const id = z.string().uuid();

/** The three hands worth remembering, strongest first. */
export const HANDS = ["royal_flush", "straight_flush", "four_of_a_kind"] as const;
export type HandKind = (typeof HANDS)[number];

export const bestHandInput = z.object({
  gameId: id,
  playerId: id,
  hand: z.enum(HANDS),
  times: z.coerce.number().int().min(1).max(99).default(1),
});

// A merged duplicate keeps its id in frozen records. Reads map it to the player it was
// merged into (one step deep), like history and statistics do.
const kept = alias(players, "kept_bh");
const resolvedId = sql<string>`coalesce(${kept.id}, ${players.id})`;
const resolvedName = sql<string>`coalesce(${kept.displayName}, ${players.displayName})`;

/**
 * Record (or correct) a best hand for one player in one game. Host only — also after the
 * game is closed, because the record is not part of the frozen result. Recording the same
 * player and hand again overwrites the count, so a wrong number is fixed by submitting again.
 */
export async function recordBestHand(tx: Tx, userId: string, input: z.input<typeof bestHandInput>) {
  const v = bestHandInput.parse(input);
  const [g] = await tx.select({ id: games.id, homeId: games.homeId }).from(games).where(eq(games.id, v.gameId));
  if (!g) throw new DomainError("NOT_FOUND");
  const [h] = await tx.select({ ownerId: homes.ownerId, readOnly: homes.readOnly }).from(homes).where(eq(homes.id, g.homeId));
  if (!h) throw new DomainError("NOT_FOUND");
  if (h.ownerId !== userId || h.readOnly) throw new DomainError("FORBIDDEN");
  // The player must belong to the same home (and must not be a merged duplicate).
  const [p] = await tx
    .select({ id: players.id })
    .from(players)
    .where(and(eq(players.id, v.playerId), eq(players.homeId, g.homeId), isNull(players.mergedInto)));
  if (!p) throw new DomainError("NOT_FOUND");
  const [row] = await tx
    .insert(bestHands)
    .values({ gameId: g.id, homeId: g.homeId, playerId: v.playerId, hand: v.hand, times: v.times, recordedBy: userId })
    .onConflictDoUpdate({
      target: [bestHands.gameId, bestHands.playerId, bestHands.hand],
      set: { times: v.times, recordedBy: userId },
    })
    .returning();
  return row!;
}

/** Remove one record. Host only. */
export async function deleteBestHand(tx: Tx, userId: string, bestHandId: string) {
  const [row] = await tx.select({ homeId: bestHands.homeId }).from(bestHands).where(eq(bestHands.id, id.parse(bestHandId)));
  if (!row) throw new DomainError("NOT_FOUND");
  const [h] = await tx.select({ ownerId: homes.ownerId, readOnly: homes.readOnly }).from(homes).where(eq(homes.id, row.homeId));
  if (!h) throw new DomainError("NOT_FOUND");
  if (h.ownerId !== userId || h.readOnly) throw new DomainError("FORBIDDEN");
  await tx.delete(bestHands).where(eq(bestHands.id, bestHandId));
}

/** Records of one game (the game page list). */
export async function gameBestHands(tx: Tx, gameId: string) {
  return tx
    .select({
      id: bestHands.id,
      playerId: resolvedId,
      name: resolvedName,
      hand: bestHands.hand,
      times: bestHands.times,
    })
    .from(bestHands)
    .innerJoin(players, eq(players.id, bestHands.playerId))
    .leftJoin(kept, eq(kept.id, players.mergedInto))
    .where(eq(bestHands.gameId, id.parse(gameId)))
    .orderBy(asc(resolvedName));
}

export interface HomeBestHandRow {
  id: string;
  gameId: string;
  number: number | null;
  /** When this game was played: closed at, or created at while it is still open. */
  at: Date;
  playerId: string;
  name: string;
  hand: HandKind;
  times: number;
}

/**
 * Every record of a home, oldest game first, with its game's number — the input for the
 * home page, the statistics page (and its PDF) and the Excel export.
 */
export async function homeBestHands(tx: Tx, homeId: string): Promise<HomeBestHandRow[]> {
  const rows = await tx
    .select({
      id: bestHands.id,
      gameId: games.id,
      number: games.number,
      closedAt: games.closedAt,
      createdAt: games.createdAt,
      playerId: resolvedId,
      name: resolvedName,
      hand: bestHands.hand,
      times: bestHands.times,
    })
    .from(bestHands)
    .innerJoin(games, eq(games.id, bestHands.gameId))
    .innerJoin(players, eq(players.id, bestHands.playerId))
    .leftJoin(kept, eq(kept.id, players.mergedInto))
    .where(eq(bestHands.homeId, id.parse(homeId)))
    .orderBy(asc(games.createdAt), asc(resolvedName));
  return rows.map((r) => ({ ...r, hand: r.hand as HandKind, at: r.closedAt ?? r.createdAt }));
}

export interface BestHandTotals {
  /** Per player: how many of each hand, and the sum of all of them, biggest total first. */
  players: { playerId: string; name: string; counts: Record<HandKind, number>; total: number }[];
  /** Grand totals per hand kind. */
  byHand: Record<HandKind, number>;
  total: number;
}

/** Add up best-hand records per player and per hand kind. Pure: pages and exports share it. */
export function bestHandTotals(rows: { playerId: string; name: string; hand: string; times: number }[]): BestHandTotals {
  const zero = (): Record<HandKind, number> => ({ royal_flush: 0, straight_flush: 0, four_of_a_kind: 0 });
  const byHand = zero();
  const byPlayer = new Map<string, { playerId: string; name: string; counts: Record<HandKind, number> }>();
  for (const r of rows) {
    if (!(HANDS as readonly string[]).includes(r.hand)) continue;
    const kind = r.hand as HandKind;
    const agg = byPlayer.get(r.playerId) ?? { playerId: r.playerId, name: r.name, counts: zero() };
    agg.counts[kind] += r.times;
    byHand[kind] += r.times;
    byPlayer.set(r.playerId, agg);
  }
  const players = [...byPlayer.values()]
    .map((p) => ({ ...p, total: HANDS.reduce((a, h) => a + p.counts[h], 0) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { players, byHand, total: HANDS.reduce((a, h) => a + byHand[h], 0) };
}
