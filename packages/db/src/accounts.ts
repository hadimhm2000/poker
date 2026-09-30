// Account module (sign-in role): recovery codes, email links, Google/Apple identities,
// account deletion. Every function here runs under asAuth(); callers check who is asking.
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Tx } from "./client";
import { DomainError } from "./repo";
import { emailTokens, recoveryCodes, sessions, userIdentities, users } from "./schema";

// ---------------------------------------------------------------- recovery codes

/** Replace a user's recovery codes (the old ones stop working). */
export async function setRecoveryCodes(tx: Tx, userId: string, hashes: Buffer[]) {
  await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  if (hashes.length) await tx.insert(recoveryCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));
}

/** Use a recovery code once. Two devices racing with the same code: only one wins. */
export async function useRecoveryCode(tx: Tx, userId: string, hash: Buffer): Promise<boolean> {
  const used = await tx
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)))
    .returning({ userId: recoveryCodes.userId });
  return used.length === 1;
}

export async function recoveryCodesLeft(tx: Tx, userId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return r?.n ?? 0;
}

// ---------------------------------------------------------------- email links

export type EmailPurpose = "verify" | "reset";

export async function createEmailToken(
  tx: Tx,
  t: { hash: Buffer; userId: string; purpose: EmailPurpose; email: string; ttlMs: number },
) {
  // One live link per purpose: a new one replaces the old.
  await tx
    .delete(emailTokens)
    .where(and(eq(emailTokens.userId, t.userId), eq(emailTokens.purpose, t.purpose), isNull(emailTokens.usedAt)));
  await tx.insert(emailTokens).values({
    tokenHash: t.hash,
    userId: t.userId,
    purpose: t.purpose,
    email: t.email,
    expiresAt: new Date(Date.now() + t.ttlMs),
  });
}

/** Spend a link once, if it is still valid. */
export async function consumeEmailToken(tx: Tx, hash: Buffer, purpose: EmailPurpose) {
  const [t] = await tx
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailTokens.tokenHash, hash),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: emailTokens.userId, email: emailTokens.email });
  if (!t) return null;
  const [u] = await tx
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, t.userId), isNull(users.deletedAt)));
  // The address changed (or the account is gone) since the link was sent.
  return u && u.email === t.email ? t : null;
}

export async function markEmailVerified(tx: Tx, userId: string) {
  await tx
    .update(users)
    .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
    .where(eq(users.id, userId));
}

/** New password after a reset link: every session ends, and the inbox is proven. */
export async function resetPassword(tx: Tx, userId: string, passwordHash: string) {
  await tx
    .update(users)
    .set({ passwordHash, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
    .where(eq(users.id, userId));
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}

// ---------------------------------------------------------------- Google and Apple

export type Provider = "google" | "apple";

export interface OidcClaims {
  provider: Provider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Sign in with a verified ID token. Known identity: that account. Otherwise an account with
 * the same email is linked only when both sides have verified that address (no takeover of
 * an unverified sign-up); a new account is created when the email is not in use.
 */
export async function oidcSignIn(tx: Tx, c: OidcClaims, locale: string): Promise<{ userId: string; created: boolean }> {
  const [known] = await tx
    .select({ userId: userIdentities.userId, deletedAt: users.deletedAt })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.provider, c.provider), eq(userIdentities.subject, c.subject)));
  if (known) {
    if (known.deletedAt) throw new DomainError("NOT_FOUND");
    return { userId: known.userId, created: false };
  }
  const email = c.email?.trim().toLowerCase() || null;
  if (email) {
    const [existing] = await tx
      .select({ id: users.id, verified: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));
    if (existing) {
      if (!c.emailVerified || !existing.verified) throw new DomainError("EMAIL_IN_USE");
      await tx.insert(userIdentities).values({ provider: c.provider, subject: c.subject, userId: existing.id, email });
      return { userId: existing.id, created: false };
    }
  }
  const [u] = await tx
    .insert(users)
    .values({
      email,
      emailVerifiedAt: email && c.emailVerified ? new Date() : null,
      displayName: (c.name ?? email?.split("@")[0] ?? "").trim().slice(0, 80),
      locale,
    })
    .returning({ id: users.id });
  await tx.insert(userIdentities).values({ provider: c.provider, subject: c.subject, userId: u!.id, email });
  return { userId: u!.id, created: true };
}

/** Add a Google or Apple login to a signed-in account. */
export async function linkIdentity(tx: Tx, userId: string, c: OidcClaims) {
  const [taken] = await tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, c.provider), eq(userIdentities.subject, c.subject)));
  if (taken && taken.userId !== userId) throw new DomainError("IDENTITY_TAKEN");
  if (taken) return;
  await tx
    .insert(userIdentities)
    .values({ provider: c.provider, subject: c.subject, userId, email: c.email })
    .onConflictDoNothing();
  const [mine] = await tx
    .select({ subject: userIdentities.subject })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, c.provider)));
  // Already linked to a different account of this provider.
  if (mine?.subject !== c.subject) throw new DomainError("IDENTITY_TAKEN");
}

/** Remove a login, unless it is the last way into the account. */
export async function unlinkIdentity(tx: Tx, userId: string, provider: Provider) {
  const [u] = await tx
    .select({ password: users.passwordHash, telegram: users.telegramId })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  const ids = await tx.select({ provider: userIdentities.provider }).from(userIdentities).where(eq(userIdentities.userId, userId));
  const others = ids.filter((i) => i.provider !== provider).length + (u?.password ? 1 : 0) + (u?.telegram ? 1 : 0);
  if (others === 0) throw new DomainError("LAST_LOGIN");
  await tx.delete(userIdentities).where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)));
}

// ---------------------------------------------------------------- deletion

export async function deleteAccount(tx: Tx, userId: string) {
  await tx.execute(sql`SELECT app.delete_account(${userId})`);
}
