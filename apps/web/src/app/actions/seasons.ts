"use server";

import { createSeason, deleteSeason } from "@poker/db";
import { monthOf } from "@poker/domain";
import { getLocale } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { defaultCalendar } from "@/i18n/routing";
import { errorCode, withUser } from "@/lib/session";

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

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function createSeasonAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const path = `/homes/${homeId}/stats`;
  const locale = await getLocale();
  let input: { name: string; startsOn: string; endsOn: string | null };
  if (form.get("preset") === "month") {
    // The current month in the viewer's calendar (Solar Hijri for Persian), named in their language.
    const calendar = defaultCalendar(locale);
    const m = monthOf(new Date(), calendar);
    const parts = new Intl.DateTimeFormat(`${locale}-u-ca-${calendar}`, { timeZone: "UTC", month: "long", year: "numeric" }).formatToParts(m.start);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    // ICU writes "1405 Mehr" for Persian; people say "Mehr 1405".
    const name = locale === "fa" ? `${part("month")} ${part("year")}` : parts.map((p) => p.value).join("");
    input = { name, startsOn: day(m.start), endsOn: day(new Date(m.end!.getTime() - 86_400_000)) };
  } else {
    input = {
      name: String(form.get("name") ?? ""),
      startsOn: String(form.get("startsOn") ?? ""),
      endsOn: String(form.get("endsOn") ?? "") || null,
    };
  }
  const s = await attempt(path, () => withUser((tx, user) => createSeason(tx, user.id, { homeId, ...input })));
  return go(`${path}?season=${s.id}`);
}

export async function deleteSeasonAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const seasonId = uuid.parse(form.get("seasonId"));
  await attempt(`/homes/${homeId}/stats`, () => withUser((tx) => deleteSeason(tx, seasonId)));
  return go(`/homes/${homeId}/stats`);
}
