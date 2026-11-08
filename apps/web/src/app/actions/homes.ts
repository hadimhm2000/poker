"use server";

import {
  DomainError,
  addPlayer,
  addToGame,
  closeGame,
  createGame,
  createHome,
  createHomeInvite,
  markPaid,
  rebuy,
  schema,
  setCashOut,
  setHouseRules,
  updateMoneySettings,
} from "@poker/db";
import { and, eq, sql } from "@poker/db";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { sha256 } from "@/lib/crypto";
import { sendInviteEmail } from "@/lib/email-links";
import { parseAmount } from "@/lib/format";
import { inviteToken, inviteTokenHash } from "@/lib/live";
import { moneySettingsOf } from "@/lib/money-units";
import { errorCode, withUser } from "@/lib/session";
import { notifyGameClosed } from "@/telegram/notify";

const uuid = z.string().uuid();

async function go(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  const sep = path.includes("?") ? "&" : "?";
  return redirect({ href: error ? `${path}${sep}error=${error}` : path, locale });
}

/** Run a mutation; on a known failure go back to `path` with an error code. */
async function attempt<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof z.ZodError) return go(path, "INVALID");
    unstable_rethrow(e);
    return go(path, errorCode(e));
  }
}

async function homeDivisor(homeId: string): Promise<number> {
  return withUser(async (tx) => {
    const [h] = await tx.select({ d: schema.homes.unitDivisor }).from(schema.homes).where(eq(schema.homes.id, homeId));
    if (!h) throw new DomainError("NOT_FOUND");
    return h.d;
  });
}

async function gameHome(gameId: string) {
  return withUser(async (tx) => {
    const [g] = await tx
      .select({ homeId: schema.games.homeId, divisor: schema.homes.unitDivisor, defaultBuyIn: schema.games.defaultBuyIn })
      .from(schema.games)
      .innerJoin(schema.homes, eq(schema.homes.id, schema.games.homeId))
      .where(eq(schema.games.id, gameId));
    if (!g) throw new DomainError("NOT_FOUND");
    return g;
  });
}

export async function createHomeAction(form: FormData) {
  const divisor = Number(form.get("unitDivisor") || 1);
  const home = await attempt("/homes", () =>
    withUser((tx, user) =>
      createHome(tx, user.id, {
        name: String(form.get("name") ?? ""),
        currency: String(form.get("currency") ?? "").trim().toUpperCase() || null,
        unitSuffix: String(form.get("unitSuffix") ?? "").trim(),
        unitDivisor: Number.isSafeInteger(divisor) && divisor > 0 ? divisor : 1,
        locale: String(form.get("locale") ?? "en") as "en",
        requireConfirmation: form.get("requireConfirmation") === "on",
      }),
    ),
  );
  return go(`/homes/${home.id}`);
}

export async function addPlayerAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  await attempt(`/homes/${homeId}`, () => withUser((tx) => addPlayer(tx, homeId, String(form.get("name") ?? ""))));
  return go(`/homes/${homeId}`);
}

export async function newGameAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const divisor = await homeDivisor(homeId);
  const buyIn = parseAmount(String(form.get("defaultBuyIn") ?? "0"), divisor);
  if (buyIn === null) return go(`/homes/${homeId}`, "INVALID");
  const game = await attempt(`/homes/${homeId}`, () => withUser((tx, user) => createGame(tx, user.id, homeId, buyIn)));
  return go(`/games/${game.id}`);
}

export async function createInviteAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const emailRaw = String(form.get("email") ?? "").trim().toLowerCase();
  if (emailRaw && !z.string().email().max(254).safeParse(emailRaw).success) return go(`/homes/${homeId}`, "INVALID");
  const email = emailRaw || null;
  await attempt(`/homes/${homeId}`, () => {
    const playerId = form.get("playerId") ? uuid.parse(form.get("playerId")) : null;
    const maxUses = z.coerce.number().int().parse(form.get("maxUses") || 1);
    // The token is an HMAC of the invite id: only its hash is stored, and the host's page
    // can show the link and its QR code again while it is valid.
    return withUser(async (tx, user) => {
      const inviteId = await createHomeInvite(tx, user.id, { homeId, playerId, maxUses, email }, inviteTokenHash);
      // The player's own email address, when the host typed one: send the link there so the
      // person lands on sign-up and their new name replaces the placeholder (0012).
      if (email) {
        const [home] = await tx
          .select({ name: schema.homes.name, locale: schema.homes.locale })
          .from(schema.homes)
          .where(eq(schema.homes.id, homeId));
        const [player] = playerId
          ? await tx.select({ n: schema.players.displayName }).from(schema.players).where(eq(schema.players.id, playerId))
          : [];
        await sendInviteEmail({
          to: email,
          locale: home?.locale ?? user.locale,
          homeName: home?.name ?? "",
          playerName: player?.n ?? null,
          token: inviteToken(inviteId),
        });
      }
      return inviteId;
    });
  });
  return go(`/homes/${homeId}#invites`);
}

export async function acceptInviteAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return go("/homes", "INVALID");
  const homeId = await attempt("/homes", () =>
    withUser(async (tx) => {
      const r = await tx.execute<{ home_id: string }>(sql`SELECT app.accept_invite(${sha256(token)}) AS home_id`);
      return r[0]!.home_id;
    }),
  );
  return go(`/homes/${homeId}`);
}

export async function markPaidAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const settlementId = uuid.parse(form.get("settlementId"));
  await attempt(`/homes/${homeId}`, () => withUser((tx, user) => markPaid(tx, user.id, settlementId)));
  return go(`/homes/${homeId}`);
}

/** Host: every open debt of this home was paid outside the app — mark them all at once. */
export async function markAllPaidAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  await attempt(`/homes/${homeId}`, () =>
    withUser(async (tx, user) => {
      const [home] = await tx
        .select({ ownerId: schema.homes.ownerId })
        .from(schema.homes)
        .where(eq(schema.homes.id, homeId));
      if (!home) throw new DomainError("NOT_FOUND");
      if (home.ownerId !== user.id) throw new DomainError("FORBIDDEN");
      const open = await tx
        .select({ id: schema.openDebts.id })
        .from(schema.openDebts)
        .where(eq(schema.openDebts.homeId, homeId));
      if (open.length) {
        await tx.insert(schema.debtPayments).values(
          open.map((r) => ({ settlementId: r.id, kind: "paid" as const, markedBy: user.id })),
        );
      }
    }),
  );
  return go(`/homes/${homeId}`);
}

// ---------------------------------------------------------------- games

export async function addToGameAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const playerId = uuid.parse(form.get("playerId"));
  await attempt(`/games/${gameId}`, () => withUser((tx, user) => addToGame(tx, user.id, gameId, playerId)));
  return go(`/games/${gameId}`);
}

export async function rebuyAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const playerId = uuid.parse(form.get("playerId"));
  const g = await gameHome(gameId);
  const raw = String(form.get("amount") ?? "").trim();
  const amount = raw ? parseAmount(raw, g.divisor) : g.defaultBuyIn;
  if (amount === null || amount <= 0) return go(`/games/${gameId}`, "INVALID");
  await attempt(`/games/${gameId}`, () => withUser((tx, user) => rebuy(tx, user.id, gameId, playerId, amount)));
  return go(`/games/${gameId}`);
}

export async function cashOutAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const playerId = uuid.parse(form.get("playerId"));
  const g = await gameHome(gameId);
  const raw = String(form.get("cashOut") ?? "").trim();
  const value = raw === "" ? null : parseAmount(raw, g.divisor);
  if (raw !== "" && value === null) return go(`/games/${gameId}`, "INVALID");
  await attempt(`/games/${gameId}`, () => withUser((tx, user) => setCashOut(tx, user.id, gameId, playerId, value)));
  return go(`/games/${gameId}`);
}

export async function confirmResultAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  await attempt(`/games/${gameId}`, () => withUser((tx) => tx.execute(sql`SELECT app.confirm_result(${gameId})`)));
  return go(`/games/${gameId}`);
}

export async function closeGameAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const closeKey = uuid.parse(form.get("closeKey"));
  const expectedVersion = z.coerce.number().int().positive().parse(form.get("version"));
  const force = form.get("force") === "1";
  try {
    // carryDebts: false — this game's settlement is about this game only. Old unpaid debts
    // stay in the home's ledger instead of being folded into tonight's "who pays whom"
    // (folding them made the numbers on the game page look wrong to the host).
    const r = await withUser((tx, user) =>
      closeGame(tx, user.id, { gameId, closeKey, expectedVersion, force, carryDebts: false }),
    );
    if (!r.alreadyClosed) {
      after(() => notifyGameClosed(gameId).catch((e: unknown) => console.error("telegram notify failed", e)));
    }
  } catch (e) {
    if (e instanceof DomainError) return go(`/games/${gameId}?summary=1${force ? "&force=1" : ""}`, e.code);
    return go(`/games/${gameId}?summary=1${force ? "&force=1" : ""}`, errorCode(e));
  }
  return go(`/games/${gameId}`);
}

export async function removeFromGameAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const playerId = uuid.parse(form.get("playerId"));
  await attempt(`/games/${gameId}`, () =>
    withUser((tx) =>
      tx
        .delete(schema.gameEntries)
        .where(and(eq(schema.gameEntries.gameId, gameId), eq(schema.gameEntries.playerId, playerId))),
    ),
  );
  return go(`/games/${gameId}`);
}

/**
 * Host: delete a game that is not closed yet (a game started by mistake, or one whose numbers
 * are beyond repair). Everything that points at the game goes with it — entries, events,
 * invites, rulings, draws — and the final delete still refuses a game that closed meanwhile.
 * A closed game is frozen history and can never be deleted.
 */
export async function deleteGameAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const homeId = await attempt(`/games/${gameId}?delete=1`, () =>
    withUser(async (tx, user) => {
      const [g] = await tx.select().from(schema.games).where(eq(schema.games.id, gameId));
      if (!g) throw new DomainError("NOT_FOUND");
      if (g.status === "closed") throw new DomainError("FROZEN");
      const [home] = await tx
        .select({ ownerId: schema.homes.ownerId, readOnly: schema.homes.readOnly })
        .from(schema.homes)
        .where(eq(schema.homes.id, g.homeId));
      if (!home) throw new DomainError("NOT_FOUND");
      if (home.ownerId !== user.id || home.readOnly) throw new DomainError("FORBIDDEN");
      await tx.execute(
        sql`DELETE FROM draw_contributions WHERE draw_id IN (SELECT id FROM game_draws WHERE game_id = ${gameId})`,
      );
      await tx.delete(schema.gameDraws).where(eq(schema.gameDraws.gameId, gameId));
      await tx.delete(schema.gameRulings).where(eq(schema.gameRulings.gameId, gameId));
      await tx.delete(schema.gameStories).where(eq(schema.gameStories.gameId, gameId));
      await tx.delete(schema.invites).where(eq(schema.invites.gameId, gameId));
      await tx.delete(schema.gameEvents).where(eq(schema.gameEvents.gameId, gameId));
      await tx.delete(schema.gameEntries).where(eq(schema.gameEntries.gameId, gameId));
      await tx.delete(schema.settlements).where(eq(schema.settlements.gameId, gameId));
      const gone = await tx
        .delete(schema.games)
        .where(and(eq(schema.games.id, gameId), sql`${schema.games.status} <> 'closed'`))
        .returning({ id: schema.games.id });
      if (!gone.length) throw new DomainError("FROZEN");
      return g.homeId;
    }),
  );
  return go(`/homes/${homeId}`);
}

export async function houseRulesAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  await attempt(`/homes/${homeId}`, () => withUser((tx) => setHouseRules(tx, homeId, String(form.get("houseRules") ?? ""))));
  return go(`/homes/${homeId}`);
}

// ---------------------------------------------------------------- money settings

/** Owner: change the home's currency label and shorthand scale (ریال/تومان + هزار/میلیون). */
export async function moneySettingsAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const unit = z.enum(["toman", "rial", "usd", "eur", "custom"]).parse(String(form.get("unit") ?? "toman"));
  const scale = z.enum(["1", "1000", "1000000"]).parse(String(form.get("scale") ?? "1"));
  const custom = z.string().max(24).parse(String(form.get("customSuffix") ?? ""));
  const locale = await getLocale();
  if (unit === "custom" && !custom.trim()) return go(`/homes/${homeId}#money`, "INVALID");
  const settings = moneySettingsOf(unit, Number(scale), custom, locale);
  await attempt(`/homes/${homeId}#money`, () => withUser((tx) => updateMoneySettings(tx, homeId, settings)));
  return go(`/homes/${homeId}#money`);
}
