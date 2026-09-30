"use server";

import {
  asAuth,
  consumeEmailToken,
  recoveryCodesLeft,
  resetPassword,
  schema,
  setRecoveryCodes,
  useRecoveryCode,
} from "@poker/db";
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
import { decryptField, encryptField, sha256 } from "@/lib/crypto";
import { sendResetEmail, sendVerificationEmail } from "@/lib/email-links";
import { RECOVERY_FLASH, generateRecoveryCodes, hashRecoveryCode, looksLikeTotp } from "@/lib/recovery";
import { getDb } from "@/lib/db";
import { safeNext } from "@/lib/next-path";
import { rateLimit } from "@/lib/rate-limit";
import { requireUser, withUser } from "@/lib/session";

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200),
});

const AFTER_SIGN_IN = "after_signin";

async function rememberNext(form: FormData) {
  const next = safeNext(form.get("next"));
  if (next) {
    (await cookies()).set(AFTER_SIGN_IN, next, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 900,
    });
  }
}

/** Where to go once fully signed in: the page that sent the user to sign in, else their homes. */
async function signedIn(): Promise<never> {
  const jar = await cookies();
  const next = safeNext(jar.get(AFTER_SIGN_IN)?.value);
  jar.delete(AFTER_SIGN_IN);
  return back(next ?? "/homes");
}

async function back(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  return redirect({ href: error ? `${path}?error=${error}` : path, locale });
}

export async function signUpAction(form: FormData) {
  await rememberNext(form);
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
  await sendVerificationEmail({ id: created[0].id, email: parsed.data.email, locale }).catch(() => false);
  return signedIn();
}

export async function signInAction(form: FormData) {
  await rememberNext(form);
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
  return user.totp ? back("/signin/2fa") : signedIn();
}

export async function verifyTwoFactorAction(form: FormData) {
  const user = await currentUser();
  if (!user) return back("/signin");
  if (!rateLimit(`2fa:${user.id}`, 6, 15 * 60e3)) return back("/signin/2fa", "rateLimited");
  const [row] = await asAuth(getDb(), (tx) =>
    tx.select({ enc: schema.users.totpSecretEnc }).from(schema.users).where(eq(schema.users.id, user.id)),
  );
  if (!row?.enc) return back("/homes");
  const code = String(form.get("code") ?? "").replace(/\s/g, "").slice(0, 40);
  // A 6-digit code from the app, or one of the single-use recovery codes.
  const valid = looksLikeTotp(code)
    ? totpFor(decryptField(row.enc), user.email ?? "").validate({ token: code, window: 1 }) !== null
    : await asAuth(getDb(), (tx) => useRecoveryCode(tx, user.id, hashRecoveryCode(code)));
  if (!valid) return back("/signin/2fa", "badCode");
  // New session id once the second factor is passed.
  await destroySession();
  await createSession(user.id, true);
  await markTwoFactorPassed(user.sessionId).catch(() => {});
  return signedIn();
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
  const codes = generateRecoveryCodes();
  await asAuth(getDb(), async (tx) => {
    await tx
      .update(schema.users)
      .set({ totpSecretEnc: encryptField(secret), totpEnabledAt: new Date() })
      .where(eq(schema.users.id, user.id));
    await tx.update(schema.sessions).set({ twoFactorPassed: true }).where(eq(schema.sessions.id, user.sessionId));
    await setRecoveryCodes(tx, user.id, codes.map(hashRecoveryCode));
  });
  jar.delete(PENDING_TOTP);
  await flashRecoveryCodes(codes);
  return back("/security/recovery");
}

/** The new codes are shown once, from a 5-minute encrypted cookie; only hashes are stored. */
async function flashRecoveryCodes(codes: string[]) {
  (await cookies()).set(RECOVERY_FLASH, encryptField(codes.join(" ")).toString("base64url"), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 300,
  });
}

/** Check the current authenticator code (or a recovery code) of a signed-in user. */
async function secondFactorOk(userId: string, email: string | null, input: string): Promise<boolean> {
  const code = input.replace(/\s/g, "").slice(0, 40);
  if (!rateLimit(`2fa-confirm:${userId}`, 6, 15 * 60e3)) return false;
  const [row] = await asAuth(getDb(), (tx) =>
    tx.select({ enc: schema.users.totpSecretEnc }).from(schema.users).where(eq(schema.users.id, userId)),
  );
  if (!row?.enc) return false;
  if (looksLikeTotp(code)) return totpFor(decryptField(row.enc), email ?? "").validate({ token: code, window: 1 }) !== null;
  return asAuth(getDb(), (tx) => useRecoveryCode(tx, userId, hashRecoveryCode(code)));
}

export async function regenerateRecoveryCodesAction(form: FormData) {
  const user = await requireUser();
  if (!(await secondFactorOk(user.id, user.email, String(form.get("code") ?? "")))) return back("/security", "badCode");
  const codes = generateRecoveryCodes();
  await asAuth(getDb(), (tx) => setRecoveryCodes(tx, user.id, codes.map(hashRecoveryCode)));
  await flashRecoveryCodes(codes);
  return back("/security/recovery");
}

export async function dismissRecoveryCodesAction() {
  await requireUser();
  (await cookies()).delete(RECOVERY_FLASH);
  return back("/security");
}

export async function disableTwoFactorAction(form: FormData) {
  const user = await requireUser();
  if (!(await secondFactorOk(user.id, user.email, String(form.get("code") ?? "")))) return back("/security", "badCode");
  await asAuth(getDb(), async (tx) => {
    await tx.update(schema.users).set({ totpSecretEnc: null, totpEnabledAt: null }).where(eq(schema.users.id, user.id));
    await setRecoveryCodes(tx, user.id, []);
  });
  return back("/security");
}

export async function recoveryCodesRemaining(userId: string) {
  return asAuth(getDb(), (tx) => recoveryCodesLeft(tx, userId));
}

// ---------------------------------------------------------------- email

export async function resendVerificationAction() {
  const user = await requireUser();
  if (!user.email || user.emailVerified) return back("/settings");
  if (!rateLimit(`verify-mail:${user.id}`, 3, 60 * 60e3)) return back("/settings", "rateLimited");
  await sendVerificationEmail({ id: user.id, email: user.email, locale: await getLocale() });
  return back("/settings?sent=1");
}

/** Always the same answer, whether or not the address has an account. */
export async function forgotPasswordAction(form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 254);
  const ip = await clientKey();
  if (!rateLimit(`forgot-ip:${ip}`, 10, 60 * 60e3) || !rateLimit(`forgot-email:${email}`, 3, 60 * 60e3)) {
    return back("/forgot", "rateLimited");
  }
  if (z.string().email().safeParse(email).success) {
    const [u] = await asAuth(getDb(), (tx) =>
      tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`${schema.users.email} = ${email} AND ${schema.users.deletedAt} IS NULL`),
    );
    if (u) await sendResetEmail({ id: u.id, email, locale: await getLocale() }).catch(() => false);
  }
  return back("/forgot?sent=1");
}

export async function resetPasswordAction(form: FormData) {
  const token = String(form.get("token") ?? "").slice(0, 100);
  const password = String(form.get("password") ?? "");
  const again = `/reset?token=${encodeURIComponent(token)}`;
  if (!rateLimit(`reset:${await clientKey()}`, 10, 15 * 60e3)) return back(again, "rateLimited");
  if (password.length < 10 || password.length > 200) return back(again, "weak");
  if (await isBreachedPassword(password)) return back(again, "breached");
  const passwordHash = await hashPassword(password);
  const ok = await asAuth(getDb(), async (tx) => {
    const t = await consumeEmailToken(tx, sha256(token), "reset");
    if (t) await resetPassword(tx, t.userId, passwordHash);
    return !!t;
  });
  if (!ok) return back("/forgot", "linkInvalid");
  await destroySession();
  return back("/signin?reset=1");
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
