import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "./client";
import { DomainError, rebuy, setCashOut } from "./repo";
import { gameEntries, gameEvents, gameNights, games, homes, invites, nightRsvps, players, telegramLinkCodes, users } from "./schema";

// Phase 3: live game (join by QR, rebuy requests, queued host changes), game nights and
// Telegram link codes. Same rule as repo.ts: every function runs inside asUser() (or
// asAuth() where stated) and RLS is the backstop.

const id = z.string().uuid();
const money = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The game a home is playing right now, if any (newest live game). */
export async function liveGame(tx: Tx, homeId: string) {
  const [g] = await tx
    .select()
    .from(games)
    .where(and(eq(games.homeId, id.parse(homeId)), eq(games.status, "live")))
    .orderBy(desc(games.createdAt))
    .limit(1);
  return g ?? null;
}

async function myEntry(tx: Tx, userId: string, gameId: string) {
  const [e] = await tx
    .select({ playerId: gameEntries.playerId, gameStatus: games.status, defaultBuyIn: games.defaultBuyIn })
    .from(gameEntries)
    .innerJoin(players, eq(players.id, gameEntries.playerId))
    .innerJoin(games, eq(games.id, gameEntries.gameId))
    .where(and(eq(gameEntries.gameId, id.parse(gameId)), eq(players.userId, userId)));
  return e ?? null;
}

// ---------------------------------------------------------------- rebuy requests

/** A player asks for a rebuy from their phone. One open request per player at a time. */
export async function requestRebuy(tx: Tx, userId: string, gameId: string, amount?: number) {
  const e = await myEntry(tx, userId, gameId);
  if (!e) throw new DomainError("NOT_IN_GAME");
  return insertRequest(tx, userId, gameId, e, amount);
}

/**
 * A rebuy request for a named player (voice messages): allowed for that player themselves or
 * the host. It still waits for the host's tap like any other request.
 */
export async function requestRebuyFor(
  tx: Tx,
  userId: string,
  gameId: string,
  playerId: string,
  amount?: number,
  details?: Record<string, unknown>,
) {
  const [e] = await tx
    .select({
      playerId: gameEntries.playerId,
      gameStatus: games.status,
      defaultBuyIn: games.defaultBuyIn,
      playerUser: players.userId,
      ownerId: homes.ownerId,
      readOnly: homes.readOnly,
    })
    .from(gameEntries)
    .innerJoin(players, eq(players.id, gameEntries.playerId))
    .innerJoin(games, eq(games.id, gameEntries.gameId))
    .innerJoin(homes, eq(homes.id, games.homeId))
    .where(and(eq(gameEntries.gameId, id.parse(gameId)), eq(gameEntries.playerId, id.parse(playerId))));
  if (!e) throw new DomainError("NOT_IN_GAME");
  if (e.playerUser !== userId && (e.ownerId !== userId || e.readOnly)) throw new DomainError("FORBIDDEN");
  return insertRequest(tx, userId, gameId, e, amount, details);
}

async function insertRequest(
  tx: Tx,
  userId: string,
  gameId: string,
  e: { playerId: string; gameStatus: string; defaultBuyIn: number },
  amount?: number,
  details?: Record<string, unknown>,
) {
  if (e.gameStatus === "closed") throw new DomainError("FROZEN");
  const a = money.parse(amount ?? e.defaultBuyIn);
  // Serialize requests of this player so two taps make one request.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`rebuy:${gameId}:${e.playerId}`}))`);
  const open = await pendingRequests(tx, gameId);
  if (open.some((r) => r.playerId === e.playerId)) throw new DomainError("ALREADY_REQUESTED");
  const [r] = await tx
    .insert(gameEvents)
    .values({ gameId, type: "request", playerId: e.playerId, amount: a, actorId: userId, details: details ?? null })
    .returning({ id: gameEvents.id });
  return { requestId: r!.id, playerId: e.playerId, amount: a };
}

/** Rebuy requests nobody has answered yet, oldest first. */
export async function pendingRequests(tx: Tx, gameId: string) {
  return tx
    .select({ id: gameEvents.id, playerId: gameEvents.playerId, amount: gameEvents.amount, at: gameEvents.at })
    .from(gameEvents)
    .where(
      and(
        eq(gameEvents.gameId, id.parse(gameId)),
        eq(gameEvents.type, "request"),
        sql`NOT EXISTS (SELECT 1 FROM game_events a WHERE a.request_id = ${gameEvents.id} AND a.type IN ('approve', 'reject'))`,
      ),
    )
    .orderBy(asc(gameEvents.at))
    .then((rows) => rows.map((r) => ({ ...r, playerId: r.playerId!, amount: r.amount! })));
}

/**
 * The host answers a request with one tap. The unique index on answers makes a second
 * answer (another device, a double tap) fail instead of adding a second rebuy.
 */
export async function answerRequest(tx: Tx, userId: string, requestId: string, approve: boolean, opKey?: string) {
  const [req] = await tx
    .select()
    .from(gameEvents)
    .where(and(eq(gameEvents.id, id.parse(requestId)), eq(gameEvents.type, "request")));
  if (!req) throw new DomainError("NOT_FOUND");
  const inserted = await tx
    .insert(gameEvents)
    .values({
      gameId: req.gameId,
      type: approve ? "approve" : "reject",
      playerId: req.playerId,
      amount: req.amount,
      requestId: req.id,
      actorId: userId,
      opKey: opKey ?? null,
    })
    .onConflictDoNothing({ target: gameEvents.requestId, where: sql`type IN ('approve', 'reject')` })
    .returning({ id: gameEvents.id });
  if (!inserted.length) throw new DomainError("ALREADY_ANSWERED");
  if (approve) await rebuy(tx, userId, req.gameId, req.playerId!, req.amount!);
  return { gameId: req.gameId, playerId: req.playerId!, amount: req.amount!, approved: approve };
}

// ---------------------------------------------------------------- queued host changes

export const hostOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rebuy"), opKey: id, playerId: id, amount: money }),
  z.object({ kind: z.literal("cash_out"), opKey: id, playerId: id, amount: z.number().int().nonnegative().nullable() }),
  z.object({ kind: z.literal("answer"), opKey: id, requestId: id, approve: z.boolean() }),
]);
export type HostOp = z.infer<typeof hostOp>;

/**
 * Apply one change the host made, possibly while offline. Each change carries a key made on
 * the phone; sending it again (the connection dropped before the answer came back) is a no-op.
 */
export async function applyHostOp(tx: Tx, userId: string, gameId: string, input: unknown) {
  const op = hostOp.parse(input);
  const [seen] = await tx.select({ id: gameEvents.id }).from(gameEvents).where(eq(gameEvents.opKey, op.opKey));
  if (seen) return { duplicate: true };
  switch (op.kind) {
    case "rebuy":
      await rebuy(tx, userId, gameId, op.playerId, op.amount, op.opKey);
      break;
    case "cash_out":
      await setCashOut(tx, userId, gameId, op.playerId, op.amount, op.opKey);
      break;
    case "answer": {
      const r = await answerRequest(tx, userId, op.requestId, op.approve, op.opKey);
      if (r.gameId !== gameId) throw new DomainError("NOT_FOUND");
      break;
    }
  }
  return { duplicate: false };
}

// ---------------------------------------------------------------- join by QR

/**
 * The game's join link (valid a day, up to 100 people). The raw token is derived from the
 * invite id by the web server (HMAC), so only its hash is stored and the QR can be redrawn.
 */
export async function ensureJoinInvite(tx: Tx, userId: string, gameId: string, hashFor: (inviteId: string) => Buffer) {
  const [g] = await tx.select().from(games).where(eq(games.id, id.parse(gameId)));
  if (!g) throw new DomainError("NOT_FOUND");
  if (g.status === "closed") throw new DomainError("FROZEN");
  const [existing] = await tx
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.gameId, g.id),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, sql`now() + interval '1 hour'`),
        sql`${invites.uses} < ${invites.maxUses}`,
      ),
    )
    .orderBy(desc(invites.createdAt))
    .limit(1);
  if (existing) return existing.id;
  const inviteId = crypto.randomUUID();
  await tx.insert(invites).values({
    id: inviteId,
    homeId: g.homeId,
    gameId: g.id,
    tokenHash: hashFor(inviteId),
    maxUses: 100,
    expiresAt: new Date(Date.now() + 864e5),
    createdBy: userId,
  });
  return inviteId;
}

export async function joinGame(tx: Tx, tokenHash: Buffer): Promise<string> {
  const r = await tx.execute<{ game_id: string }>(sql`SELECT app.join_game(${tokenHash}) AS game_id`);
  return r[0]!.game_id;
}

export async function claimPlayer(tx: Tx, gameId: string, playerId: string) {
  await tx.execute(sql`SELECT app.claim_player(${id.parse(gameId)}, ${id.parse(playerId)})`);
}

export async function confirmResult(tx: Tx, gameId: string) {
  await tx.execute(sql`SELECT app.confirm_result(${id.parse(gameId)})`);
}

// ---------------------------------------------------------------- game nights

export const nightInput = z.object({
  homeId: id,
  startsAt: z.coerce.date().refine((d) => d.getTime() > Date.now() - 36e5, "in the past"),
  place: z.string().trim().max(120).default(""),
  note: z.string().trim().max(500).default(""),
});

export async function createNight(tx: Tx, userId: string, input: z.input<typeof nightInput>) {
  const v = nightInput.parse(input);
  const [n] = await tx.insert(gameNights).values({ ...v, createdBy: userId }).returning();
  return n!;
}

export async function cancelNight(tx: Tx, nightId: string) {
  const r = await tx
    .update(gameNights)
    .set({ canceledAt: new Date() })
    .where(and(eq(gameNights.id, id.parse(nightId)), isNull(gameNights.canceledAt)))
    .returning({ id: gameNights.id });
  if (!r.length) throw new DomainError("NOT_FOUND");
}

export const rsvpAnswer = z.enum(["yes", "no", "maybe"]);

export async function rsvp(tx: Tx, userId: string, nightId: string, answer: z.input<typeof rsvpAnswer>) {
  const a = rsvpAnswer.parse(answer);
  const [n] = await tx.select().from(gameNights).where(eq(gameNights.id, id.parse(nightId)));
  if (!n) throw new DomainError("NOT_FOUND");
  if (n.canceledAt) throw new DomainError("CANCELED");
  await tx
    .insert(nightRsvps)
    .values({ nightId: n.id, userId, answer: a })
    .onConflictDoUpdate({ target: [nightRsvps.nightId, nightRsvps.userId], set: { answer: a, updatedAt: new Date() } });
  return n;
}

/** Upcoming (or just started) nights of a home with everyone's answers. */
export async function upcomingNights(tx: Tx, homeId: string) {
  const nights = await tx
    .select()
    .from(gameNights)
    .where(
      and(
        eq(gameNights.homeId, id.parse(homeId)),
        isNull(gameNights.canceledAt),
        gt(gameNights.startsAt, sql`now() - interval '6 hours'`),
      ),
    )
    .orderBy(asc(gameNights.startsAt));
  return Promise.all(nights.map(async (n) => ({ ...n, answers: await nightAnswers(tx, n.id) })));
}

/** Answers for one night. Names come from the member's player in that home (users are private). */
export async function nightAnswers(tx: Tx, nightId: string) {
  const [n] = await tx.select({ homeId: gameNights.homeId }).from(gameNights).where(eq(gameNights.id, nightId));
  if (!n) return [];
  return tx
    .select({ userId: nightRsvps.userId, answer: nightRsvps.answer, name: players.displayName })
    .from(nightRsvps)
    .leftJoin(players, and(eq(players.userId, nightRsvps.userId), eq(players.homeId, n.homeId)))
    .where(eq(nightRsvps.nightId, nightId))
    .orderBy(asc(nightRsvps.updatedAt));
}

// ---------------------------------------------------------------- Telegram link codes (asAuth)

export async function createLinkCode(
  tx: Tx,
  codeHash: Buffer,
  v: { purpose: "account" | "group"; userId: string; homeId?: string | null },
) {
  await tx.insert(telegramLinkCodes).values({
    codeHash,
    purpose: v.purpose,
    userId: v.userId,
    homeId: v.homeId ?? null,
    expiresAt: new Date(Date.now() + 15 * 60e3),
  });
}

/** Use a code once. Returns what it was issued for, or null when unknown, used or expired. */
export async function consumeLinkCode(tx: Tx, codeHash: Buffer, purpose: "account" | "group") {
  const [c] = await tx
    .update(telegramLinkCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(telegramLinkCodes.codeHash, codeHash),
        eq(telegramLinkCodes.purpose, purpose),
        isNull(telegramLinkCodes.usedAt),
        gt(telegramLinkCodes.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return c ?? null;
}

/**
 * Attach a Telegram account to a site account (asAuth). Fails if that Telegram account is
 * already attached to someone else, so one person cannot take over another's account.
 */
export async function linkTelegramAccount(tx: Tx, userId: string, telegramId: number) {
  const [other] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.telegramId, telegramId), ne(users.id, userId)));
  if (other) throw new DomainError("TELEGRAM_TAKEN");
  await tx.update(users).set({ telegramId }).where(eq(users.id, userId));
}
