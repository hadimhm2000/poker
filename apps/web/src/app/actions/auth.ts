"use server";

import { asAuth, schema } from "@poker/db";
import { eq, sql } from "@poker/db";
import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";
import { Secret } from "otpauth";
import { PENDING_TOTP, totpFor } from "@/lib/totp";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import {
  clientKey,
  createSession,
  currentUser,
  destroySession,
  hashPassword,
  isBreachedPassword,
  markTwoFactorPassed,
  verifyPassword,
} from "@/lib/auth";
import { decryptField, encryptField } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { requireUser, withUser } from "@/lib/session";

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200),
});

async function back(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  return redirect({ href: error ? `${path}?error=${error}` : path, locale });
}

export async function signUpAction(form: FormData) {
  const ip = await clientKey();
  if (!rateLimit(`signup:${ip}`, 5, 60 * 60e3)) return back("/signup", "rateLimited");
  const parsed = credentials.extend({ displayName: z.string().trim().min(1).max(80) }).safeParse({
    email: form.get("email"),
    password: form.get("password"),
    displayName: form.get("displayName"),
  });
  if (!parsed.success) return back("/signup", "weak");
  if (await isBreachedPassword(parsed.data.password)) return back("/signup", "breached");

  const locale = await getLocale();
  const passwordHash = await hashPassword(parsed.data.password);
  const created = await asAuth(getDb(), (tx) =>
    tx
      .insert(schema.users)
      .values({ email: parsed.data.email, passwordHash, displayName: parsed.data.displayName, locale })
      .onConflictDoNothing()
      .returning({ id: schema.users.id }),
  );
  if (!created[0]) return back("/signup", "cannotCreate");
  await createSession(created[0].id, false);
  return back("/homes");
}

export async function signInAction(form: FormData) {
  const ip = await clientKey();
  const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 254);
  // Per-IP and per-account limits. The response is the same whether or not the email exists.
  if (!rateLimit(`signin-ip:${ip}`, 20, 15 * 60e3) || !rateLimit(`signin-email:${email}`, 8, 15 * 60e3)) {
    return back("/signin", "rateLimited");
  }
  const password = String(form.get("password") ?? "").slice(0, 200);
  const [user] = await asAuth(getDb(), (tx) =>
    tx
      .select({ id: schema.users.id, passwordHash: schema.users.passwordHash, totp: schema.users.totpEnabledAt })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${email} AND ${schema.users.deletedAt} IS NULL`),
  );
  const ok = await verifyPassword(user?.passwordHash ?? null, password);
  if (!user || !ok) return back("/signin", "invalid");
  await destroySession();
  await createSession(user.id, false);
  return back(user.totp ? "/signin/2fa" : "/homes");
}

export async function verifyTwoFactorAction(form: FormData) {
  const user = await currentUser();
  if (!user) return back("/signin");
  if (!rateLimit(`2fa:${user.id}`, 6, 15 * 60e3)) return back("/signin/2fa", "rateLimited");
  const [row] = await asAuth(getDb(), (tx) =>
    tx.select({ enc: schema.users.totpSecretEnc }).from(schema.users).where(eq(schema.users.id, user.id)),
  );
  if (!row?.enc) return back("/homes");
  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  const valid = totpFor(decryptField(row.enc), user.email ?? "").validate({ token: code, window: 1 }) !== null;
  if (!valid) return back("/signin/2fa", "badCode");
  // New session id once the second factor is passed.
  await destroySession();
  await createSession(user.id, true);
  await markTwoFactorPassed(user.sessionId).catch(() => {});
  return back("/homes");
}

/** Step 1: create a secret, keep it encrypted in a short-lived httpOnly cookie until verified. */
export async function startTwoFactorAction() {
  await requireUser();
  const secret = new Secret({ size: 20 }).base32;
  (await cookies()).set(PENDING_TOTP, encryptField(secret).toString("base64url"), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return back("/security");
}

/** Step 2: the user proves the authenticator works before it is switched on. */
export async function enableTwoFactorAction(form: FormData) {
  const user = await requireUser();
  const jar = await cookies();
  const pending = jar.get(PENDING_TOTP)?.value;
  if (!pending) return back("/security");
  const secret = decryptField(Buffer.from(pending, "base64url"));
  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  if (!rateLimit(`2fa-setup:${user.id}`, 10, 15 * 60e3)) return back("/security", "rateLimited");
  if (totpFor(secret, user.email ?? "").validate({ token: code, window: 1 }) === null) {
    return back("/security", "badCode");
  }
  await asAuth(getDb(), async (tx) => {
    await tx
      .update(schema.users)
      .set({ totpSecretEnc: encryptField(secret), totpEnabledAt: new Date() })
      .where(eq(schema.users.id, user.id));
    await tx.update(schema.sessions).set({ twoFactorPassed: true }).where(eq(schema.sessions.id, user.sessionId));
  });
  jar.delete(PENDING_TOTP);
  return back("/security");
}

export async function signOutAllAction() {
  await withUser((tx, user) => tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id)));
  await destroySession();
  return back("/signin");
}

export async function signOutAction() {
  await destroySession();
  return back("/");
}
