"use server";

import { deleteBestHand, recordBestHand } from "@poker/db";
import { getLocale } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { errorCode, withUser } from "@/lib/session";

// Best hand (بهترین دست): the host records royal flush / straight flush / four of a kind,
// per game. The form lives on the game page and on the home page; `from` says which one to
// return to. Members never reach these actions' bodies with a change (RLS refuses too).

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

/** Where to come back to after a change: the game page or the home page section. */
function backTo(form: FormData): string {
  const gameId = uuid.parse(form.get("gameId"));
  const homeId = uuid.parse(form.get("homeId"));
  return form.get("from") === "home" ? `/homes/${homeId}#besthand` : `/games/${gameId}#besthand`;
}

/** Host: record a best hand for one player of the game (submitting again corrects the count). */
export async function recordBestHandAction(form: FormData) {
  const gameId = uuid.parse(form.get("gameId"));
  const back = backTo(form);
  await attempt(back, () =>
    withUser((tx, user) =>
      recordBestHand(tx, user.id, {
        gameId,
        playerId: uuid.parse(form.get("playerId")),
        // The enum is re-validated inside recordBestHand; a bad value lands in attempt().
        hand: String(form.get("hand") ?? "") as "royal_flush" | "straight_flush" | "four_of_a_kind",
        times: Number(form.get("times") ?? 1) || 1,
      }),
    ),
  );
  return go(back);
}

/** Host: remove one best-hand record. */
export async function deleteBestHandAction(form: FormData) {
  const bestHandId = uuid.parse(form.get("id"));
  const back = backTo(form);
  await attempt(back, () => withUser((tx, user) => deleteBestHand(tx, user.id, bestHandId)));
  return go(back);
}
