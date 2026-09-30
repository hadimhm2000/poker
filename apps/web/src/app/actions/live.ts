"use server";

import { claimPlayer, ensureJoinInvite, joinGame, requestRebuy } from "@poker/db";
import { getLocale } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { sha256 } from "@/lib/crypto";
import { joinTokenHash } from "@/lib/live";
import { errorCode, withUser } from "@/lib/session";
import { notifyRebuyRequest } from "@/telegram/notify";

const uuid = z.string().uuid();

async function go(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  const sep = path.includes("?") ? "&" : "?";
  return redirect({ href: error ? `${path}${sep}error=${error}` : path, locale });
}

async function attempt<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof z.ZodError) return go(path, "INVALID");
    unstable_rethrow(e);
    return go(path, errorCode(e));
  }
}

/** Host: make (or reuse) the game's join link so the QR code can be shown. */
export async function makeJoinLinkAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  await attempt(`/games/${gameId}`, () => withUser((tx, user) => ensureJoinInvite(tx, user.id, gameId, joinTokenHash)));
  return go(`/games/${gameId}`);
}

/** Player: scanned the QR code and pressed "Join". */
export async function joinGameAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return go("/homes", "INVALID");
  const gameId = await attempt("/homes", () => withUser((tx) => joinGame(tx, sha256(token))));
  return go(`/games/${gameId}`);
}

/** Player: "this is me" on an account-less player of the game. */
export async function claimPlayerAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const playerId = uuid.parse(form.get("playerId"));
  await attempt(`/games/${gameId}`, () => withUser((tx) => claimPlayer(tx, gameId, playerId)));
  return go(`/games/${gameId}`);
}

/** Player: ask the host for a rebuy of the game's default buy-in. */
export async function requestRebuyAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const r = await attempt(`/games/${gameId}`, () => withUser((tx, user) => requestRebuy(tx, user.id, gameId)));
  after(() => notifyRebuyRequest(r.requestId).catch((e: unknown) => console.error("telegram notify failed", e)));
  return go(`/games/${gameId}`);
}
