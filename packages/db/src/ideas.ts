import { type RulingInput, judge, payerIndex, randomHex32, verifyDraw } from "@poker/domain";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "./client";
import { DomainError } from "./repo";
import {
  drawContributions,
  gameDraws,
  gameEntries,
  gameEvents,
  gameRulings,
  gameStories,
  games,
  homes,
  nettingProposals,
  openDebts,
  players,
  settlements,
} from "./schema";

// Special ideas #2 to #7. Same rule as repo.ts: every function runs inside asUser() (or
// asJobs() where stated) and RLS is the backstop for each rule stated here.

const id = z.string().uuid();
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------- home settings

/** Options the host switches on per home (homes.settings). Both are off unless turned on. */
export const homeSettingsInput = z.object({
  /** Show each player's average days to pay on the statistics page (inside this home only). */
  goodPayerIndex: z.boolean().optional(),
  /** Write a short AI story of the night after each close (names and numbers of that game). */
  nightStory: z.boolean().optional(),
});
export type HomeSettings = z.infer<typeof homeSettingsInput> & { debtReminderDays?: number };

export function homeSettings(settings: unknown): HomeSettings {
  return (settings && typeof settings === "object" ? settings : {}) as HomeSettings;
}

export async function setHomeSettings(tx: Tx, homeId: string, patch: z.input<typeof homeSettingsInput>) {
  const v = homeSettingsInput.parse(patch);
  const done = await tx
    .update(homes)
    .set({ settings: sql`${homes.settings} || ${JSON.stringify(v)}::jsonb` })
    .where(eq(homes.id, id.parse(homeId)))
    .returning({ id: homes.id });
  if (!done.length) throw new DomainError("NOT_FOUND");
}

// ---------------------------------------------------------------- #2 companion referee

export const rulingInput = z.object({
  variant: z.enum(["holdem", "omaha"]),
  board: z.string().trim().min(1).max(40),
  hands: z
    .array(z.object({ label: z.string().trim().max(40).default(""), cards: z.string().trim().min(1).max(40) }))
    .min(2)
    .max(10),
});

/**
 * Decide a disputed showdown and record it in the game's log. Anyone in the game (a player
 * or the host) may, while the game is not closed; the log itself is append-only.
 */
export async function addRuling(
  tx: Tx,
  userId: string,
  gameId: string,
  input: z.input<typeof rulingInput>,
  via: "web" | "telegram" = "web",
) {
  const v = rulingInput.parse(input);
  const [g] = await tx.select({ id: games.id, homeId: games.homeId, status: games.status }).from(games).where(eq(games.id, id.parse(gameId)));
  if (!g) throw new DomainError("NOT_FOUND");
  if (g.status === "closed") throw new DomainError("FROZEN");
  let r;
  try {
    r = judge(v as RulingInput);
  } catch (e) {
    throw new DomainError("INVALID", (e as Error).message);
  }
  const [row] = await tx
    .insert(gameRulings)
    .values({
      gameId: g.id,
      homeId: g.homeId,
      variant: r.variant,
      board: r.board,
      hands: r.hands,
      winners: r.winners,
      decidedBy: r.decidedBy,
      situation: r.situation,
      via,
      actorId: userId,
    })
    .returning();
  return row!;
}

export async function listRulings(tx: Tx, gameId: string) {
  return tx.select().from(gameRulings).where(eq(gameRulings.gameId, id.parse(gameId))).orderBy(desc(gameRulings.createdAt));
}

export type RulingRow = Awaited<ReturnType<typeof listRulings>>[number];

// ---------------------------------------------------------------- #3 fair draw

/** Host: start a draw among the game's players. The seed never leaves the database until reveal. */
export async function startDraw(tx: Tx, gameId: string, seed: string = randomHex32()): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`SELECT app.start_draw(${id.parse(gameId)}, ${hex32.parse(seed)}) AS id`);
  return r[0]!.id;
}

/** A player adds their own random value (made on their phone) while the draw is open. */
export async function contributeToDraw(tx: Tx, userId: string, drawId: string, value: string) {
  const [d] = await tx.select().from(gameDraws).where(eq(gameDraws.id, id.parse(drawId)));
  if (!d) throw new DomainError("NOT_FOUND");
  if (d.revealedAt) throw new DomainError("ALREADY_ANSWERED");
  const [p] = await tx
    .select({ id: players.id })
    .from(players)
    .where(and(eq(players.userId, userId), inArray(players.id, d.players)));
  if (!p) throw new DomainError("NOT_IN_GAME");
  const inserted = await tx
    .insert(drawContributions)
    .values({ drawId: d.id, playerId: p.id, userId, value: hex32.parse(value) })
    .onConflictDoNothing()
    .returning({ playerId: drawContributions.playerId });
  if (!inserted.length) throw new DomainError("ALREADY_ANSWERED");
  return { gameId: d.gameId, playerId: p.id };
}

/** Host: reveal the seed. Returns the game id. */
export async function revealDraw(tx: Tx, drawId: string): Promise<string> {
  const r = await tx.execute<{ game_id: string }>(sql`SELECT app.reveal_draw(${id.parse(drawId)}) AS game_id`);
  return r[0]!.game_id;
}

/** The newest draw of a game (open or revealed), or null. */
export async function latestDraw(tx: Tx, gameId: string) {
  const [d] = await tx
    .select({ id: gameDraws.id })
    .from(gameDraws)
    .where(eq(gameDraws.gameId, id.parse(gameId)))
    .orderBy(desc(gameDraws.createdAt))
    .limit(1);
  return d ? drawDetails(tx, d.id) : null;
}

/** Everything the verification page shows, recomputed from scratch. Works as a member or as jobs. */
export async function drawDetails(tx: Tx, drawId: string) {
  const [d] = await tx.select().from(gameDraws).where(eq(gameDraws.id, id.parse(drawId)));
  if (!d) return null;
  const contributions = await tx
    .select({ playerId: drawContributions.playerId, value: drawContributions.value, at: drawContributions.createdAt })
    .from(drawContributions)
    .where(eq(drawContributions.drawId, d.id))
    .orderBy(asc(drawContributions.playerId));
  const names = new Map(
    (await tx.select({ id: players.id, name: players.displayName }).from(players).where(inArray(players.id, d.players))).map((p) => [
      p.id,
      p.name,
    ]),
  );
  const check = d.seed
    ? await verifyDraw(d.commit, { seed: d.seed, players: d.players, contributions: contributions.map((c) => ({ playerId: c.playerId, value: c.value })) })
    : null;
  return { draw: d, contributions, names, check };
}

export type DrawDetails = NonNullable<Awaited<ReturnType<typeof drawDetails>>>;

// ---------------------------------------------------------------- #4 cross-home netting

export interface NettingCandidate {
  otherUserId: string;
  otherName: string;
  /** I owe them here. */
  mine: { settlementId: string; homeId: string; homeName: string; gameNumber: number | null; amount: number };
  /** They owe me here (another home). */
  theirs: { settlementId: string; homeId: string; homeName: string; gameNumber: number | null; amount: number };
  amount: number;
}

async function myOpenDebts(tx: Tx, userId: string) {
  return tx
    .select({
      settlementId: openDebts.id,
      homeId: openDebts.homeId,
      homeName: homes.name,
      gameNumber: openDebts.gameNumber,
      remaining: openDebts.remaining,
      fromUser: sql<string | null>`(SELECT user_id FROM players WHERE id = ${openDebts.fromPlayer})`,
      toUser: sql<string | null>`(SELECT user_id FROM players WHERE id = ${openDebts.toPlayer})`,
      fromName: sql<string>`(SELECT display_name FROM players WHERE id = ${openDebts.fromPlayer})`,
      toName: sql<string>`(SELECT display_name FROM players WHERE id = ${openDebts.toPlayer})`,
    })
    .from(openDebts)
    .innerJoin(homes, eq(homes.id, openDebts.homeId))
    .where(
      sql`${userId}::uuid IN ((SELECT user_id FROM players WHERE id = ${openDebts.fromPlayer}), (SELECT user_id FROM players WHERE id = ${openDebts.toPlayer}))`,
    )
    .orderBy(asc(openDebts.closedAt));
}

/** Pairs of my open debts that could be netted: I owe X in one home, X owes me in another. */
export async function nettingCandidates(tx: Tx, userId: string): Promise<NettingCandidate[]> {
  const rows = await myOpenDebts(tx, userId);
  const iOwe = rows.filter((r) => r.fromUser === userId && r.toUser && r.toUser !== userId);
  const owedToMe = rows.filter((r) => r.toUser === userId && r.fromUser && r.fromUser !== userId);
  const out: NettingCandidate[] = [];
  for (const m of iOwe) {
    for (const t of owedToMe) {
      if (t.fromUser !== m.toUser || t.homeId === m.homeId) continue;
      out.push({
        otherUserId: m.toUser!,
        otherName: m.toName,
        mine: { settlementId: m.settlementId, homeId: m.homeId, homeName: m.homeName, gameNumber: m.gameNumber, amount: m.remaining },
        theirs: { settlementId: t.settlementId, homeId: t.homeId, homeName: t.homeName, gameNumber: t.gameNumber, amount: t.remaining },
        amount: Math.min(m.remaining, t.remaining),
      });
    }
  }
  return out;
}

export async function proposeNetting(tx: Tx, mine: string, theirs: string): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`SELECT app.propose_netting(${id.parse(mine)}, ${id.parse(theirs)}) AS id`);
  return r[0]!.id;
}

export async function answerNetting(tx: Tx, proposalId: string, accept: boolean) {
  await tx.execute(sql`SELECT app.answer_netting(${id.parse(proposalId)}, ${accept})`);
}

export async function cancelNetting(tx: Tx, proposalId: string) {
  await tx.execute(sql`SELECT app.cancel_netting(${id.parse(proposalId)})`);
}

/** My netting proposals (made or received), with both debts described. Only the two parties see them. */
export async function listNetting(tx: Tx, opts: { homeId?: string; status?: "pending" } = {}) {
  const debt = (col: typeof nettingProposals.proposerDebt | typeof nettingProposals.responderDebt) => ({
    home: sql<string | null>`(SELECT g.home_id FROM settlements s JOIN games g ON g.id = s.game_id WHERE s.id = ${col})`,
    homeName: sql<string | null>`(SELECT h.name FROM settlements s JOIN games g ON g.id = s.game_id JOIN homes h ON h.id = g.home_id WHERE s.id = ${col})`,
    gameNumber: sql<number | null>`(SELECT g.number FROM settlements s JOIN games g ON g.id = s.game_id WHERE s.id = ${col})`,
    from: sql<string | null>`(SELECT p.display_name FROM settlements s JOIN players p ON p.id = s.from_player WHERE s.id = ${col})`,
    to: sql<string | null>`(SELECT p.display_name FROM settlements s JOIN players p ON p.id = s.to_player WHERE s.id = ${col})`,
  });
  const rows = await tx
    .select({
      p: nettingProposals,
      a: debt(nettingProposals.proposerDebt),
      b: debt(nettingProposals.responderDebt),
    })
    .from(nettingProposals)
    .where(opts.status ? eq(nettingProposals.status, opts.status) : undefined)
    .orderBy(desc(nettingProposals.createdAt))
    .limit(50);
  return opts.homeId ? rows.filter((r) => r.a.home === opts.homeId || r.b.home === opts.homeId) : rows;
}

export type NettingRow = Awaited<ReturnType<typeof listNetting>>[number];

// ---------------------------------------------------------------- #6 good-payer index

/**
 * Average days from close to paid per debtor, inside one home. Returns null when the host
 * has not turned it on for this home.
 */
export async function goodPayerIndex(tx: Tx, homeId: string) {
  const [h] = await tx.select({ settings: homes.settings }).from(homes).where(eq(homes.id, id.parse(homeId)));
  if (!h || !homeSettings(h.settings).goodPayerIndex) return null;
  // Settled debts: fully paid or fully netted; the last payment is when it was settled.
  const paid = await tx.execute<{ player_id: string; name: string; closed_at: Date; paid_at: Date }>(sql`
    SELECT s.from_player AS player_id, p.display_name AS name, g.closed_at, max(d.marked_at) AS paid_at
    FROM settlements s
    JOIN games g ON g.id = s.game_id
    JOIN players p ON p.id = s.from_player
    JOIN debt_payments d ON d.settlement_id = s.id AND d.kind IN ('paid', 'netted')
    WHERE g.home_id = ${homeId} AND g.status = 'closed'
      AND NOT EXISTS (SELECT 1 FROM debt_payments c WHERE c.settlement_id = s.id AND c.kind = 'carried')
      AND NOT EXISTS (SELECT 1 FROM open_debts o WHERE o.id = s.id)
    GROUP BY s.id, s.from_player, p.display_name, g.closed_at`);
  const open = await tx
    .select({ playerId: openDebts.fromPlayer, name: players.displayName })
    .from(openDebts)
    .innerJoin(players, eq(players.id, openDebts.fromPlayer))
    .where(eq(openDebts.homeId, homeId));
  return payerIndex(
    paid.map((r) => ({ playerId: r.player_id, name: r.name, closedAt: new Date(r.closed_at), paidAt: new Date(r.paid_at) })),
    open,
  );
}

// ---------------------------------------------------------------- #7 night story

/**
 * The facts of one closed game for its story: names and numbers of that game only.
 * Runs as the jobs role (after close, outside any request) or as a member.
 */
export async function nightFacts(tx: Tx, gameId: string) {
  const [g] = await tx
    .select({ game: games, home: homes })
    .from(games)
    .innerJoin(homes, eq(homes.id, games.homeId))
    .where(eq(games.id, id.parse(gameId)));
  if (!g || g.game.status !== "closed") return null;
  const rows = await tx
    .select({
      playerId: players.id,
      name: players.displayName,
      totalIn: gameEntries.totalIn,
      cashOut: gameEntries.cashOut,
      rebuys: sql<number>`(SELECT count(*) FROM game_events e WHERE e.game_id = ${gameEntries.gameId} AND e.player_id = ${gameEntries.playerId} AND e.type = 'rebuy')`.mapWith(Number),
    })
    .from(gameEntries)
    .innerJoin(players, eq(players.id, gameEntries.playerId))
    .where(eq(gameEntries.gameId, g.game.id));
  const transfers = await tx
    .select({ from: settlements.fromPlayer, to: settlements.toPlayer, amount: settlements.amount })
    .from(settlements)
    .where(eq(settlements.gameId, g.game.id));
  const [biggestRebuy] = await tx
    .select({ amount: sql<number>`max(${gameEvents.amount})`.mapWith(Number) })
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, g.game.id), eq(gameEvents.type, "rebuy"), isNotNull(gameEvents.amount)));
  return {
    gameId: g.game.id,
    homeId: g.home.id,
    locale: g.home.locale,
    settings: homeSettings(g.home.settings),
    money: { currency: g.home.currency, unitSuffix: g.home.unitSuffix, unitDivisor: g.home.unitDivisor },
    number: g.game.number!,
    startedAt: g.game.startedAt,
    closedAt: g.game.closedAt!,
    rows: rows.map((r) => ({ ...r, cashOut: r.cashOut ?? 0, net: (r.cashOut ?? 0) - r.totalIn })),
    transfers,
    biggestRebuy: biggestRebuy?.amount || null,
  };
}

export type NightFacts = NonNullable<Awaited<ReturnType<typeof nightFacts>>>;

/** Store the story once (jobs role). A second write for the same game is ignored. */
export async function saveStory(tx: Tx, v: { gameId: string; homeId: string; locale: string; body: string; model: string }) {
  const r = await tx.insert(gameStories).values(v).onConflictDoNothing().returning({ gameId: gameStories.gameId });
  return r.length > 0;
}

export async function gameStory(tx: Tx, gameId: string) {
  const [s] = await tx.select().from(gameStories).where(eq(gameStories.gameId, id.parse(gameId)));
  return s ?? null;
}
