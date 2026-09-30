import {
  type CloseBlocker,
  GENESIS_HASH,
  type Transfer,
  closeBlockers,
  computeClose,
  gameHash,
} from "@poker/domain";
import { and, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Tx } from "./client";
import { debtPayments, gameEntries, gameEvents, games, homes, players, settlements } from "./schema";

// All functions take a transaction already scoped with asUser(): RLS is the backstop,
// but each function also states its own rules so errors are clear and early.

// A merged duplicate keeps its id in frozen games. Reads map it to the player it was merged
// into (merges keep chains one step deep), so statistics and debts count under one name.
const kept = alias(players, "kept");
const keptFrom = alias(players, "kept_from");
const keptTo = alias(players, "kept_to");
const fromOf = alias(players, "from_of");
const toOf = alias(players, "to_of");
const resolvedId = sql<string>`coalesce(${kept.id}, ${players.id})`;
const resolvedName = sql<string>`coalesce(${kept.displayName}, ${players.displayName})`;

export class DomainError extends Error {
  constructor(
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().uuid();

export const createHomeInput = z.object({
  name: z.string().trim().min(1).max(60),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  unitSuffix: z.string().max(8).default(""),
  unitDivisor: z.number().int().positive().default(1),
  locale: z.enum(["fa", "en", "ar", "fr", "it", "ru", "es"]).default("en"),
  requireConfirmation: z.boolean().default(false),
});

export async function createHome(tx: Tx, ownerId: string, input: z.input<typeof createHomeInput>) {
  const v = createHomeInput.parse(input);
  const [home] = await tx.insert(homes).values({ ...v, ownerId }).returning();
  return home!;
}

export async function addPlayer(tx: Tx, homeId: string, displayName: string) {
  const name = z.string().trim().min(1).max(40).parse(displayName);
  const [p] = await tx.insert(players).values({ homeId: id.parse(homeId), displayName: name }).returning();
  return p!;
}

export async function createGame(tx: Tx, userId: string, homeId: string, defaultBuyIn = 0) {
  const [g] = await tx
    .insert(games)
    .values({ homeId: id.parse(homeId), createdBy: userId, defaultBuyIn: money.parse(defaultBuyIn), status: "live", startedAt: new Date() })
    .returning();
  return g!;
}

async function openGame(tx: Tx, gameId: string) {
  const [g] = await tx.select().from(games).where(eq(games.id, id.parse(gameId)));
  if (!g) throw new DomainError("NOT_FOUND");
  if (g.status === "closed") throw new DomainError("FROZEN", "game is closed");
  return g;
}

export async function addToGame(tx: Tx, userId: string, gameId: string, playerId: string, buyIn?: number) {
  const g = await openGame(tx, gameId);
  const amount = money.parse(buyIn ?? g.defaultBuyIn);
  await tx.insert(gameEntries).values({ gameId: g.id, playerId: id.parse(playerId), totalIn: amount });
  await tx.insert(gameEvents).values({ gameId: g.id, playerId, type: "buy_in", amount, actorId: userId });
}

export async function rebuy(tx: Tx, userId: string, gameId: string, playerId: string, amount?: number, opKey?: string) {
  const g = await openGame(tx, gameId);
  const a = money.parse(amount ?? g.defaultBuyIn);
  const updated = await tx
    .update(gameEntries)
    .set({ totalIn: sql`${gameEntries.totalIn} + ${a}`, confirmedAt: null })
    .where(and(eq(gameEntries.gameId, g.id), eq(gameEntries.playerId, id.parse(playerId))))
    .returning();
  if (!updated.length) throw new DomainError("NOT_IN_GAME");
  await tx.insert(gameEvents).values({ gameId: g.id, playerId, type: "rebuy", amount: a, actorId: userId, opKey: opKey ?? null });
}

export async function setCashOut(
  tx: Tx,
  userId: string,
  gameId: string,
  playerId: string,
  cashOut: number | null,
  opKey?: string,
) {
  const g = await openGame(tx, gameId);
  const v = cashOut === null ? null : money.parse(cashOut);
  const updated = await tx
    .update(gameEntries)
    .set({ cashOut: v, confirmedAt: null })
    .where(and(eq(gameEntries.gameId, g.id), eq(gameEntries.playerId, id.parse(playerId))))
    .returning();
  if (!updated.length) throw new DomainError("NOT_IN_GAME");
  await tx.insert(gameEvents).values({ gameId: g.id, playerId, type: "cash_out", amount: v, actorId: userId, opKey: opKey ?? null });
}

async function loadEntries(tx: Tx, gameId: string) {
  return tx
    .select({
      playerId: gameEntries.playerId,
      totalIn: gameEntries.totalIn,
      cashOut: gameEntries.cashOut,
      confirmedAt: gameEntries.confirmedAt,
      userId: players.userId,
    })
    .from(gameEntries)
    .innerJoin(players, eq(players.id, gameEntries.playerId))
    .where(eq(gameEntries.gameId, gameId));
}

export async function gameBlockers(tx: Tx, gameId: string): Promise<CloseBlocker[]> {
  const g = await openGame(tx, gameId);
  const [home] = await tx.select().from(homes).where(eq(homes.id, g.homeId));
  const entries = await loadEntries(tx, g.id);
  return closeBlockers(
    entries.map((e) => ({ ...e, hasAccount: !!e.userId, confirmed: !!e.confirmedAt })),
    { requireConfirmation: home!.requireConfirmation },
  );
}

/**
 * Unpaid, not-yet-carried settlements from earlier games in this home, with merged players
 * mapped to the player they were merged into.
 */
export async function openDebts(tx: Tx, homeId: string) {
  return tx
    .select({
      id: settlements.id,
      from: sql<string>`coalesce(${keptFrom.id}, ${settlements.fromPlayer})`,
      to: sql<string>`coalesce(${keptTo.id}, ${settlements.toPlayer})`,
      amount: settlements.amount,
    })
    .from(settlements)
    .innerJoin(games, eq(games.id, settlements.gameId))
    .innerJoin(fromOf, eq(fromOf.id, settlements.fromPlayer))
    .leftJoin(keptFrom, eq(keptFrom.id, fromOf.mergedInto))
    .innerJoin(toOf, eq(toOf.id, settlements.toPlayer))
    .leftJoin(keptTo, eq(keptTo.id, toOf.mergedInto))
    .where(
      and(
        eq(games.homeId, id.parse(homeId)),
        eq(games.status, "closed"),
        notExists(tx.select({ x: sql`1` }).from(debtPayments).where(eq(debtPayments.settlementId, settlements.id))),
      ),
    );
}

export const closeGameInput = z.object({
  gameId: id,
  /** Client-generated per click; a retried or doubled request reuses it. */
  closeKey: id,
  /** The version the host saw on the summary screen. */
  expectedVersion: z.number().int().positive(),
  /** Net open debts of players in this game into the new settlement. */
  carryDebts: z.boolean().default(true),
});

/** Internal options used by the importer; never taken from a request. */
interface CloseOptions {
  closedAt?: Date;
  imported?: boolean;
}

export interface CloseResult {
  gameId: string;
  number: number;
  hash: string;
  transfers: Transfer[];
  alreadyClosed: boolean;
}

/**
 * Close and freeze a game. Safe against double clicks and two devices at once:
 * the game row is locked, the close key makes retries return the same result, and
 * the version check rejects a close based on numbers that changed since the summary.
 */
export async function closeGame(
  tx: Tx,
  userId: string,
  input: z.input<typeof closeGameInput>,
  opts: CloseOptions = {},
): Promise<CloseResult> {
  const v = closeGameInput.parse(input);
  const [g] = await tx.select().from(games).where(eq(games.id, v.gameId)).for("update");
  if (!g) throw new DomainError("NOT_FOUND");

  if (g.status === "closed") {
    if (g.closeKey !== v.closeKey) throw new DomainError("FROZEN", "game is already closed");
    const rows = await tx.select().from(settlements).where(eq(settlements.gameId, g.id));
    return {
      gameId: g.id,
      number: g.number!,
      hash: g.hash!,
      transfers: rows.map((r) => ({ from: r.fromPlayer, to: r.toPlayer, amount: r.amount })),
      alreadyClosed: true,
    };
  }
  if (g.version !== v.expectedVersion) {
    throw new DomainError("STALE", "numbers changed since the summary was shown", { version: g.version });
  }

  // One close at a time per home keeps numbering and the hash chain linear.
  const [home] = await tx.select().from(homes).where(eq(homes.id, g.homeId)).for("update");
  if (!home) throw new DomainError("NOT_FOUND");

  const entries = await loadEntries(tx, g.id);
  const inGame = new Set(entries.map((e) => e.playerId));
  const carried = v.carryDebts
    ? (await openDebts(tx, home.id)).filter((d) => inGame.has(d.from) && inGame.has(d.to))
    : [];

  let result;
  try {
    result = computeClose(
      entries.map((e) => ({ ...e, hasAccount: !!e.userId, confirmed: !!e.confirmedAt })),
      { requireConfirmation: home.requireConfirmation && !opts.imported, allowZeroBuyIn: opts.imported },
      carried,
    );
  } catch (err) {
    const blockers = (err as { blockers?: CloseBlocker[] }).blockers;
    if (blockers) throw new DomainError("BLOCKED", "game cannot be closed yet", blockers);
    throw err;
  }

  if (result.transfers.length) {
    await tx.insert(settlements).values(
      result.transfers.map((t) => ({ gameId: g.id, fromPlayer: t.from, toPlayer: t.to, amount: t.amount })),
    );
  }
  if (carried.length) {
    await tx.insert(debtPayments).values(
      carried.map((d) => ({ settlementId: d.id, kind: "carried" as const, carriedToGame: g.id, markedBy: userId })),
    );
  }

  const [last] = await tx
    .select({ number: games.number, hash: games.hash })
    .from(games)
    .where(and(eq(games.homeId, home.id), eq(games.status, "closed")))
    .orderBy(desc(games.number))
    .limit(1);
  const number = (last?.number ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const closedAt = opts.closedAt ?? new Date();
  const hash = await gameHash(prevHash, {
    homeId: home.id,
    number,
    closedAt: closedAt.toISOString(),
    currency: home.currency,
    entries: entries.map((e) => ({ playerId: e.playerId, totalIn: e.totalIn, cashOut: e.cashOut! })),
  });

  const closed = await tx
    .update(games)
    .set({ status: "closed", number, closedAt, closeKey: v.closeKey, hash, prevHash })
    .where(and(eq(games.id, g.id), eq(games.version, v.expectedVersion)))
    .returning({ id: games.id });
  if (!closed.length) throw new DomainError("STALE");

  return { gameId: g.id, number, hash, transfers: result.transfers, alreadyClosed: false };
}

export const historyQuery = z.object({
  homeIds: z.array(id).optional(),
  player: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  number: z.number().int().positive().optional(),
  outcome: z.enum(["win", "loss", "even"]).optional(),
  minAbs: money.optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

/** Rows of the history sheet (sheet 2): one per player per closed game. RLS limits it to the user's homes. */
export async function history(tx: Tx, q: z.input<typeof historyQuery>) {
  const v = historyQuery.parse(q);
  const net = sql<number>`(${gameEntries.cashOut} - ${gameEntries.totalIn})`;
  const conds = [eq(games.status, "closed")];
  if (v.homeIds?.length) conds.push(inArray(games.homeId, v.homeIds));
  if (v.player) conds.push(sql`${resolvedName} ILIKE ${"%" + v.player.replace(/[%_\\]/g, "\\$&") + "%"}`);
  if (v.from) conds.push(sql`${games.closedAt} >= ${v.from}`);
  if (v.to) conds.push(sql`${games.closedAt} <= ${v.to}`);
  if (v.number) conds.push(eq(games.number, v.number));
  if (v.outcome === "win") conds.push(sql`${net} > 0`);
  if (v.outcome === "loss") conds.push(sql`${net} < 0`);
  if (v.outcome === "even") conds.push(sql`${net} = 0`);
  if (v.minAbs !== undefined) conds.push(sql`abs(${net}) >= ${v.minAbs}`);
  return tx
    .select({
      homeId: games.homeId,
      gameId: games.id,
      number: games.number,
      closedAt: games.closedAt,
      playerId: resolvedId,
      player: resolvedName,
      totalIn: gameEntries.totalIn,
      cashOut: gameEntries.cashOut,
      net: sql<number>`${net}::bigint`.mapWith(Number),
    })
    .from(gameEntries)
    .innerJoin(games, eq(games.id, gameEntries.gameId))
    .innerJoin(players, eq(players.id, gameEntries.playerId))
    .leftJoin(kept, eq(kept.id, players.mergedInto))
    .where(and(...conds))
    .orderBy(desc(games.closedAt), asc(resolvedName))
    .limit(v.limit);
}

/** Open debts in a home (the ledger), merged players mapped like in openDebts. */
export async function ledger(tx: Tx, homeId: string) {
  return tx
    .select({
      settlementId: settlements.id,
      gameNumber: games.number,
      from: sql<string>`coalesce(${keptFrom.id}, ${settlements.fromPlayer})`,
      to: sql<string>`coalesce(${keptTo.id}, ${settlements.toPlayer})`,
      amount: settlements.amount,
    })
    .from(settlements)
    .innerJoin(games, eq(games.id, settlements.gameId))
    .innerJoin(fromOf, eq(fromOf.id, settlements.fromPlayer))
    .leftJoin(keptFrom, eq(keptFrom.id, fromOf.mergedInto))
    .innerJoin(toOf, eq(toOf.id, settlements.toPlayer))
    .leftJoin(keptTo, eq(keptTo.id, toOf.mergedInto))
    .leftJoin(debtPayments, eq(debtPayments.settlementId, settlements.id))
    .where(and(eq(games.homeId, id.parse(homeId)), isNull(debtPayments.id)))
    .orderBy(asc(games.number));
}

export async function markPaid(tx: Tx, userId: string, settlementId: string) {
  await tx.insert(debtPayments).values({ settlementId: id.parse(settlementId), kind: "paid", markedBy: userId });
}

/**
 * Every player's result in every closed game of a home: the input for statistics and exports.
 * A merged duplicate's frozen rows count under the kept player (one row per player per game,
 * summed if both sat in the same closed game). Nothing frozen is rewritten; this is a read.
 */
export async function resultRows(tx: Tx, homeId: string) {
  return tx
    .select({
      gameId: games.id,
      number: games.number,
      closedAt: games.closedAt,
      playerId: resolvedId,
      name: resolvedName,
      totalIn: sql<number>`sum(${gameEntries.totalIn})::bigint`.mapWith(Number),
      cashOut: sql<number>`sum(coalesce(${gameEntries.cashOut}, 0))::bigint`.mapWith(Number),
    })
    .from(gameEntries)
    .innerJoin(games, eq(games.id, gameEntries.gameId))
    .innerJoin(players, eq(players.id, gameEntries.playerId))
    .leftJoin(kept, eq(kept.id, players.mergedInto))
    .where(and(eq(games.homeId, id.parse(homeId)), eq(games.status, "closed")))
    .groupBy(games.id, games.number, games.closedAt, resolvedId, resolvedName)
    .orderBy(asc(games.closedAt), asc(games.number), asc(resolvedName))
    .then((rows) => rows.map((r) => ({ ...r, number: r.number!, closedAt: r.closedAt! })));
}

export const importGameInput = z.object({
  homeId: id,
  playedAt: z.coerce.date(),
  rows: z
    .array(z.object({ name: z.string().trim().min(1).max(40), totalIn: money, cashOut: money }))
    .min(2)
    .max(40),
});

/**
 * Record one game from an old spreadsheet. It goes through the same close path as a live
 * game (same checks, same hash chain); its settlement is marked as already paid so old
 * nights do not show up as open debts.
 */
export async function importGame(tx: Tx, userId: string, input: z.input<typeof importGameInput>) {
  const v = importGameInput.parse(input);
  const existing = await tx.select().from(players).where(eq(players.homeId, v.homeId));
  const byName = new Map(existing.filter((p) => !p.mergedInto).map((p) => [p.displayName.toLowerCase(), p.id]));
  const game = await createGame(tx, userId, v.homeId, 0);
  for (const r of v.rows) {
    let pid = byName.get(r.name.toLowerCase());
    if (!pid) {
      pid = (await addPlayer(tx, v.homeId, r.name)).id;
      byName.set(r.name.toLowerCase(), pid);
    }
    await tx.insert(gameEntries).values({ gameId: game.id, playerId: pid, totalIn: r.totalIn, cashOut: r.cashOut });
  }
  const [cur] = await tx.select({ version: games.version }).from(games).where(eq(games.id, game.id));
  const result = await closeGame(
    tx,
    userId,
    { gameId: game.id, closeKey: crypto.randomUUID(), expectedVersion: cur!.version, carryDebts: false },
    { closedAt: v.playedAt, imported: true },
  );
  const rows = await tx.select({ id: settlements.id }).from(settlements).where(eq(settlements.gameId, game.id));
  if (rows.length) {
    await tx.insert(debtPayments).values(rows.map((r) => ({ settlementId: r.id, kind: "paid" as const, markedBy: userId })));
  }
  return result;
}

/** 'free' | 'pro' of the home's owner, or null when the caller is not a member. */
export async function homePlan(tx: Tx, homeId: string): Promise<"free" | "pro" | null> {
  const r = await tx.execute<{ plan: "free" | "pro" | null }>(sql`SELECT app.home_plan(${id.parse(homeId)}) AS plan`);
  return r[0]?.plan ?? null;
}
