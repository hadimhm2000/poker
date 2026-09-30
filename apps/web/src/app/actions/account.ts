"use server";

import { asAuth, asUser, deleteAccount, schema, unlinkIdentity } from "@poker/db";
import { eq } from "@poker/db";
import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { verifyPassword } from "@/lib/auth";
import { destroySession } from "@/lib/auth";
import { decryptField } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { hashRecoveryCode, looksLikeTotp } from "@/lib/recovery";
import { errorCode, requireUser } from "@/lib/session";
import { THEME_COOKIE, isTheme } from "@/lib/theme";
import { totpFor } from "@/lib/totp";
import { useRecoveryCode } from "@poker/db";

async function back(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  const sep = path.includes("?") ? "&" : "?";
  return redirect({ href: error ? `${path}${sep}error=${error}` : path, locale });
}

export async function setThemeAction(form: FormData) {
  const theme = String(form.get("theme") ?? "");
  const jar = await cookies();
  if (isTheme(theme) && theme !== "system") {
    jar.set(THEME_COOKIE, theme, { path: "/", maxAge: 365 * 864e2, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  } else jar.delete(THEME_COOKIE);
  return back("/settings");
}

export async function saveProfileAction(form: FormData) {
  const user = await requireUser();
  const name = String(form.get("displayName") ?? "").trim().slice(0, 80);
  if (!name) return back("/settings", "INVALID");
  await asUser(getDb(), user.id, (tx) => tx.update(schema.users).set({ displayName: name }).where(eq(schema.users.id, user.id)));
  return back("/settings?saved=1");
}

export async function saveNotificationsAction(form: FormData) {
  const user = await requireUser();
  const on = (k: string) => form.get(k) === "on";
  const settings = { nightReminders: on("nightReminders"), nightEmails: on("nightEmails"), debtReminders: on("debtReminders") };
  await asUser(getDb(), user.id, (tx) => tx.update(schema.users).set({ settings }).where(eq(schema.users.id, user.id)));
  return back("/settings?saved=1");
}

export async function unlinkIdentityAction(form: FormData) {
  const user = await requireUser();
  const provider = form.get("provider");
  if (provider !== "google" && provider !== "apple") return back("/security");
  try {
    await asAuth(getDb(), (tx) => unlinkIdentity(tx, user.id, provider));
  } catch (e) {
    return back("/security", errorCode(e));
  }
  return back("/security");
}

/**
 * Delete the account. The person types DELETE and proves it is them again: the password if
 * the account has one, and the authenticator (or a recovery code) if two-step is on.
 */
export async function deleteAccountAction(form: FormData) {
  const user = await requireUser();
  if (!rateLimit(`delete:${user.id}`, 5, 60 * 60e3)) return back("/settings", "rateLimited");
  if (String(form.get("confirm") ?? "").trim().toUpperCase() !== "DELETE") return back("/settings", "confirmDelete");
  const [u] = await asAuth(getDb(), (tx) =>
    tx
      .select({ passwordHash: schema.users.passwordHash, enc: schema.users.totpSecretEnc })
      .from(schema.users)
      .where(eq(schema.users.id, user.id)),
  );
  if (!u) return back("/signin");
  if (u.passwordHash && !(await verifyPassword(u.passwordHash, String(form.get("password") ?? "").slice(0, 200)))) {
    return back("/settings", "invalid");
  }
  if (u.enc) {
    const code = String(form.get("code") ?? "").replace(/\s/g, "").slice(0, 40);
    const ok = looksLikeTotp(code)
      ? totpFor(decryptField(u.enc), user.email ?? "").validate({ token: code, window: 1 }) !== null
      : await asAuth(getDb(), (tx) => useRecoveryCode(tx, user.id, hashRecoveryCode(code)));
    if (!ok) return back("/settings", "badCode");
  }
  await asAuth(getDb(), (tx) => deleteAccount(tx, user.id));
  await destroySession();
  return back("/?deleted=1");
}
