"use server";

import { asAuth, createLinkCode, schema } from "@poker/db";
import { eq } from "@poker/db";
import { getLocale } from "next-intl/server";
import { redirect as externalRedirect } from "next/navigation";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { randomToken, sha256 } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { requireUser, withUser } from "@/lib/session";
import { botUsername, telegramConfigured } from "@/telegram/instance";

const uuid = z.string().uuid();

async function back(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  return redirect({ href: error ? `${path}?error=${error}` : path, locale });
}

/** Security page: open the bot with a one-time code that links this Telegram account. */
export async function connectTelegramAction() {
  const user = await requireUser();
  if (!telegramConfigured()) return back("/security", "ERROR");
  if (!rateLimit(`tg-code:${user.id}`, 10, 60 * 60e3)) return back("/security", "rateLimited");
  const code = randomToken();
  await asAuth(getDb(), (tx) => createLinkCode(tx, sha256(code), { purpose: "account", userId: user.id }));
  return externalRedirect(`https://t.me/${botUsername()}?start=${code}`);
}

export async function disconnectTelegramAction() {
  const user = await requireUser();
  await asAuth(getDb(), (tx) => tx.update(schema.users).set({ telegramId: null }).where(eq(schema.users.id, user.id)));
  return back("/security");
}

/** Home page (host): add the bot to a group; Telegram sends the code there with /start. */
export async function connectGroupAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const user = await requireUser();
  if (!telegramConfigured()) return back(`/homes/${homeId}`, "ERROR");
  if (!rateLimit(`tg-code:${user.id}`, 10, 60 * 60e3)) return back(`/homes/${homeId}`, "rateLimited");
  // Only the host may link; checked here through RLS (a member cannot update the home).
  const owns = await withUser(async (tx) => {
    const [h] = await tx.select({ owner: schema.homes.ownerId }).from(schema.homes).where(eq(schema.homes.id, homeId));
    return h?.owner === user.id;
  });
  if (!owns) return back(`/homes/${homeId}`, "FORBIDDEN");
  const code = randomToken();
  await asAuth(getDb(), (tx) => createLinkCode(tx, sha256(code), { purpose: "group", userId: user.id, homeId }));
  return externalRedirect(`https://t.me/${botUsername()}?startgroup=${code}`);
}

export async function disconnectGroupAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  await withUser((tx) => tx.update(schema.homes).set({ telegramChatId: null }).where(eq(schema.homes.id, homeId)));
  return back(`/homes/${homeId}`);
}
