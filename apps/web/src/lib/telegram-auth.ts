import "server-only";
import { asAuth, schema } from "@poker/db";
import { and, eq, isNull } from "@poker/db";
import { locales } from "@/i18n/routing";
import type { TelegramUser } from "@/telegram/verify";
import { createSession, destroySession } from "./auth";
import { getDb } from "./db";

/**
 * Sign in with a verified Telegram identity. A Telegram account already linked to a site
 * account signs into that account; otherwise a new account is made for it (plan: "/start:
 * connect Telegram to a site account or create one"). A user with 2FA still has to pass it.
 */
export async function signInWithTelegram(tg: TelegramUser, opts: { embedded?: boolean } = {}) {
  const db = getDb();
  const find = () =>
    asAuth(db, (tx) =>
      tx
        .select({ id: schema.users.id, totp: schema.users.totpEnabledAt, locale: schema.users.locale })
        .from(schema.users)
        .where(and(eq(schema.users.telegramId, tg.id), isNull(schema.users.deletedAt))),
    );
  let [user] = await find();
  let created = false;
  if (!user) {
    const lang = tg.language_code?.slice(0, 2);
    const displayName = [tg.first_name, tg.last_name].filter(Boolean).join(" ").slice(0, 80) || tg.username || "Player";
    await asAuth(db, (tx) =>
      tx
        .insert(schema.users)
        .values({ telegramId: tg.id, displayName, locale: locales.includes(lang as never) ? lang! : "en" })
        .onConflictDoNothing(),
    );
    [user] = await find();
    created = true;
  }
  if (!user) throw new Error("could not create the account");
  await destroySession();
  await createSession(user.id, false, opts);
  return { userId: user.id, needsTwoFactor: !!user.totp, locale: user.locale, created };
}
