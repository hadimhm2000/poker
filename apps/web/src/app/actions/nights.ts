"use server";

import { cancelNight, createNight, rsvp } from "@poker/db";
import { getLocale } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { errorCode, withUser } from "@/lib/session";
import { notifyNight } from "@/telegram/notify";

const uuid = z.string().uuid();

async function go(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  return redirect({ href: error ? `${path}?error=${error}` : path, locale });
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

const telegram = (nightId: string) =>
  after(() => notifyNight(nightId).catch((e: unknown) => console.error("telegram notify failed", e)));

export async function createNightAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const path = `/homes/${homeId}/nights`;
  const n = await attempt(path, () =>
    withUser((tx, user) =>
      createNight(tx, user.id, {
        homeId,
        // An ISO instant made in the browser from the host's local date and time.
        startsAt: String(form.get("startsAt") ?? ""),
        place: String(form.get("place") ?? ""),
        note: String(form.get("note") ?? ""),
      }),
    ),
  );
  telegram(n.id);
  return go(path);
}

export async function rsvpAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const nightId = uuid.parse(form.get("nightId"));
  const answer = String(form.get("answer") ?? "") as "yes";
  await attempt(`/homes/${homeId}/nights`, () => withUser((tx, user) => rsvp(tx, user.id, nightId, answer)));
  telegram(nightId);
  return go(`/homes/${homeId}/nights`);
}

export async function cancelNightAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const nightId = uuid.parse(form.get("nightId"));
  await attempt(`/homes/${homeId}/nights`, () => withUser((tx) => cancelNight(tx, nightId)));
  telegram(nightId);
  return go(`/homes/${homeId}/nights`);
}
