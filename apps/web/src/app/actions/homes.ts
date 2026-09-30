"use server";

import {
  DomainError,
  addPlayer,
  addToGame,
  closeGame,
  createGame,
  createHome,
  markPaid,
  rebuy,
  schema,
  setCashOut,
} from "@poker/db";
import { and, eq, sql } from "@poker/db";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { randomToken, sha256 } from "@/lib/crypto";
import { parseAmount } from "@/lib/format";
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
  const playerId = form.get("playerId") ? uuid.parse(form.get("playerId")) : null;
  const token = randomToken();
  await attempt(`/homes/${homeId}`, () =>
    withUser((tx, user) =>
      tx.insert(schema.invites).values({
        homeId,
        playerId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 7 * 864e5),
        createdBy: user.id,
      }),
    ),
  );
  // Shown once to the host (flash cookie, not the URL); only its hash is stored.
  (await cookies()).set("invite_flash", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 120,
  });
  return go(`/homes/${homeId}`);
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
  try {
    const r = await withUser((tx, user) => closeGame(tx, user.id, { gameId, closeKey, expectedVersion }));
    if (!r.alreadyClosed) {
      after(() => notifyGameClosed(gameId).catch((e: unknown) => console.error("telegram notify failed", e)));
    }
  } catch (e) {
    if (e instanceof DomainError) return go(`/games/${gameId}?summary=1`, e.code);
    return go(`/games/${gameId}?summary=1`, errorCode(e));
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
