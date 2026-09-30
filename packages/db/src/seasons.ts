import { type Period, type Transfer, canonicalJson, gameHash, hashPayload, verifyChain } from "@poker/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "./client";
import { DomainError } from "./repo";
import { gameEntries, games, homes, players, seasons, settlements } from "./schema";

const id = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------------------------------------------------------------- seasons

export const seasonInput = z
  .object({
    homeId: id,
    name: z.string().trim().min(1).max(60),
    startsOn: day,
    endsOn: day.nullable().default(null),
  })
  .refine((s) => s.endsOn === null || s.endsOn >= s.startsOn, { message: "end before start", path: ["endsOn"] });

export async function createSeason(tx: Tx, userId: string, input: z.input<typeof seasonInput>) {
  const v = seasonInput.parse(input);
  const [s] = await tx
    .insert(seasons)
    .values({ ...v, createdBy: userId })
    .returning();
  return s!;
}

export async function deleteSeason(tx: Tx, seasonId: string) {
  const gone = await tx.delete(seasons).where(eq(seasons.id, id.parse(seasonId))).returning({ id: seasons.id });
  if (!gone.length) throw new DomainError("NOT_FOUND");
}

export async function listSeasons(tx: Tx, homeId: string) {
  return tx
    .select()
    .from(seasons)
    .where(eq(seasons.homeId, id.parse(homeId)))
    .orderBy(desc(seasons.startsOn), asc(seasons.name));
}

/** A season as a half-open UTC period (the end day is included). */
export function seasonPeriod(s: { startsOn: string; endsOn: string | null }): Period {
  const start = new Date(`${s.startsOn}T00:00:00Z`);
  const end = s.endsOn ? new Date(new Date(`${s.endsOn}T00:00:00Z`).getTime() + 86_400_000) : null;
  return { start, end };
}

// ---------------------------------------------------------------- house rules

export async function setHouseRules(tx: Tx, homeId: string, text: string) {
  const v = z.string().max(2000).parse(text.replace(/\r\n/g, "\n").trim());
  const done = await tx.update(homes).set({ houseRules: v }).where(eq(homes.id, id.parse(homeId))).returning({ id: homes.id });
  if (!done.length) throw new DomainError("NOT_FOUND");
}

// ---------------------------------------------------------------- result card

/** Everything the result card shows, for a member of the game's home. */
export async function resultCard(tx: Tx, gameId: string) {
  const [g] = await tx
    .select({
      id: games.id,
      status: games.status,
      number: games.number,
      closedAt: games.closedAt,
      hash: games.hash,
      homeName: homes.name,
      locale: homes.locale,
      currency: homes.currency,
      unitSuffix: homes.unitSuffix,
      unitDivisor: homes.unitDivisor,
    })
    .from(games)
    .innerJoin(homes, eq(homes.id, games.homeId))
    .where(eq(games.id, id.parse(gameId)));
  if (!g) throw new DomainError("NOT_FOUND");
  if (g.status !== "closed") throw new DomainError("NOT_CLOSED");
  const rows = await tx
    .select({
      playerId: players.id,
      name: players.displayName,
      totalIn: gameEntries.totalIn,
      cashOut: gameEntries.cashOut,
    })
    .from(gameEntries)
    .innerJoin(players, eq(players.id, gameEntries.playerId))
    .where(eq(gameEntries.gameId, g.id))
    .orderBy(sql`${gameEntries.cashOut} - ${gameEntries.totalIn} DESC`, asc(players.displayName));
  const transfers: Transfer[] = (
    await tx
      .select({ from: settlements.fromPlayer, to: settlements.toPlayer, amount: settlements.amount })
      .from(settlements)
      .where(eq(settlements.gameId, g.id))
  ).map((t) => ({ from: t.from, to: t.to, amount: t.amount }));
  return {
    ...g,
    number: g.number!,
    closedAt: g.closedAt!,
    hash: g.hash!,
    rows: rows.map((r) => ({ ...r, cashOut: r.cashOut ?? 0, net: (r.cashOut ?? 0) - r.totalIn })),
    transfers,
  };
}

export type ResultCardData = Awaited<ReturnType<typeof resultCard>>;

/** The latest closed game of a home, or null. */
export async function lastClosedGame(tx: Tx, homeId: string): Promise<string | null> {
  const [g] = await tx
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.homeId, id.parse(homeId)), eq(games.status, "closed")))
    .orderBy(desc(games.number))
    .limit(1);
  return g?.id ?? null;
}

// ---------------------------------------------------------------- verification

interface VerifyRow {
  homeId: string;
  homeName: string;
  locale: string;
  currency: string | null;
  unitSuffix: string;
  unitDivisor: number;
  number: number;
  closedAt: string;
  hash: string;
  prevHash: string;
  entries: { playerId: string; name: string; totalIn: number; cashOut: number }[];
  chain: { number: number; closedAt: string; hash: string; prevHash: string; entries: { playerId: string; totalIn: number; cashOut: number }[] }[];
}

export interface Verification {
  homeName: string;
  locale: string;
  currency: string | null;
  unitSuffix: string;
  unitDivisor: number;
  number: number;
  closedAt: Date;
  hash: string;
  prevHash: string;
  entries: { name: string; totalIn: number; cashOut: number; net: number }[];
  /** This game's numbers still produce its hash. */
  gameIntact: boolean;
  /** Every game of the home up to this one links and verifies. */
  chainIntact: boolean;
  chainLength: number;
  /** Exactly what was hashed, so anyone can recompute it: sha256(prevHash + "\n" + payload). */
  payload: string;
}

/**
 * Look up a closed game by its hash (from the QR on a result card) and recheck it and the
 * chain behind it. Runs as the sign-in role: anyone holding the hash may see this one game.
 */
export async function verifyByHash(tx: Tx, hash: string): Promise<Verification | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const [r] = await tx.execute<{ v: VerifyRow | null }>(sql`SELECT app.verify_game(${hash}) AS v`);
  const v = r?.v;
  if (!v) return null;
  const game = (c: { number: number; closedAt: string; entries: VerifyRow["chain"][number]["entries"] }) => ({
    homeId: v.homeId,
    number: c.number,
    closedAt: new Date(c.closedAt).toISOString(),
    currency: v.currency,
    entries: c.entries.map((e) => ({ playerId: e.playerId, totalIn: Number(e.totalIn), cashOut: Number(e.cashOut) })),
  });
  const self = game(v);
  const gameIntact = (await gameHash(v.prevHash, self)) === v.hash;
  const links = v.chain.map((c) => ({ game: game(c), prevHash: c.prevHash, hash: c.hash }));
  const chainIntact = gameIntact && (await verifyChain(links)) === -1;
  return {
    homeName: v.homeName,
    locale: v.locale,
    currency: v.currency,
    unitSuffix: v.unitSuffix,
    unitDivisor: v.unitDivisor,
    number: v.number,
    closedAt: new Date(v.closedAt),
    hash: v.hash,
    prevHash: v.prevHash,
    entries: v.entries.map((e) => {
      const totalIn = Number(e.totalIn);
      const cashOut = Number(e.cashOut);
      return { name: e.name, totalIn, cashOut, net: cashOut - totalIn };
    }),
    gameIntact,
    chainIntact,
    chainLength: links.length,
    payload: canonicalJson(hashPayload(self)),
  };
}
