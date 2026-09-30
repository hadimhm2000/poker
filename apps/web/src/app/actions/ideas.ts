"use server";

import {
  addRuling,
  answerNetting,
  cancelNetting,
  contributeToDraw,
  proposeNetting,
  revealDraw,
  setHomeSettings,
  startDraw,
} from "@poker/db";
import { getLocale } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { errorCode, withUser } from "@/lib/session";
import { notifyDraw } from "@/telegram/notify";

// Special ideas: companion referee, fair draw, cross-home netting, home options.

const uuid = z.string().uuid();

async function go(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  const [base, hash] = path.split("#");
  const sep = base!.includes("?") ? "&" : "?";
  return redirect({ href: `${error ? `${base}${sep}error=${error}` : base}${hash ? `#${hash}` : ""}`, locale });
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

const notify = (drawId: string) => after(() => notifyDraw(drawId).catch((e: unknown) => console.error("telegram notify failed", e)));

// ---------------------------------------------------------------- referee

/** Anyone in the game: decide a disputed showdown and add it to the game's log. */
export async function judgeAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const hands: { label: string; cards: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const cards = String(form.get(`cards_${i}`) ?? "").trim();
    if (cards) hands.push({ label: String(form.get(`label_${i}`) ?? ""), cards });
  }
  await attempt(`/games/${gameId}#referee`, () =>
    withUser((tx, user) =>
      addRuling(tx, user.id, gameId, {
        variant: form.get("variant") === "omaha" ? "omaha" : "holdem",
        board: String(form.get("board") ?? ""),
        hands,
      }),
    ),
  );
  return go(`/games/${gameId}#referee`);
}

// ---------------------------------------------------------------- fair draw

export async function startDrawAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const drawId = await attempt(`/games/${gameId}#draw`, () => withUser((tx) => startDraw(tx, gameId)));
  notify(drawId);
  return go(`/draws/${drawId}`);
}

/** A player's own random value, made in their browser (crypto.getRandomValues). */
export async function contributeDrawAction(form: FormData) {
  const drawId = uuid.parse(form.get("drawId"));
  const value = String(form.get("value") ?? "");
  await attempt(`/draws/${drawId}`, () => withUser((tx, user) => contributeToDraw(tx, user.id, drawId, value)));
  return go(`/draws/${drawId}`);
}

export async function revealDrawAction(form: FormData) {
  const drawId = uuid.parse(form.get("drawId"));
  await attempt(`/draws/${drawId}`, () => withUser((tx) => revealDraw(tx, drawId)));
  notify(drawId);
  return go(`/draws/${drawId}`);
}

// ---------------------------------------------------------------- netting

export async function proposeNettingAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const mine = uuid.parse(form.get("mine"));
  const theirs = uuid.parse(form.get("theirs"));
  await attempt(`/homes/${homeId}#netting`, () => withUser((tx) => proposeNetting(tx, mine, theirs)));
  return go(`/homes/${homeId}#netting`);
}

export async function answerNettingAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const proposalId = uuid.parse(form.get("proposalId"));
  const accept = form.get("answer") === "accept";
  await attempt(`/homes/${homeId}#netting`, () => withUser((tx) => answerNetting(tx, proposalId, accept)));
  return go(`/homes/${homeId}#netting`);
}

export async function cancelNettingAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const proposalId = uuid.parse(form.get("proposalId"));
  await attempt(`/homes/${homeId}#netting`, () => withUser((tx) => cancelNetting(tx, proposalId)));
  return go(`/homes/${homeId}#netting`);
}

// ---------------------------------------------------------------- home options

export async function homeOptionsAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  await attempt(`/homes/${homeId}`, () =>
    withUser((tx) =>
      setHomeSettings(tx, homeId, {
        goodPayerIndex: form.get("goodPayerIndex") === "on",
        nightStory: form.get("nightStory") === "on",
      }),
    ),
  );
  return go(`/homes/${homeId}#options`);
}
