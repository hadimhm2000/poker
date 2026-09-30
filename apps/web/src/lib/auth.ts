import "server-only";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { asAuth, schema } from "@poker/db";
import { and, eq, gt, sql } from "@poker/db";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { getDb } from "./db";
import { randomToken, sha256 } from "./crypto";

export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-session" : "session";
const SESSION_DAYS = 30;

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 /* Argon2id */ } as const;

export const hashPassword = (password: string) => argonHash(password, ARGON);

// A real hash to verify against when the email does not exist, so timing does not reveal it.
let dummyHash: Promise<string> | null = null;

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hashPassword("not-a-real-password");
    await argonVerify(await dummyHash, password).catch(() => false);
    return false;
  }
  return argonVerify(stored, password).catch(() => false);
}

/**
 * Have I Been Pwned range check (k-anonymity: only the first 5 hex chars of the SHA-1 leave
 * the server). Fails open: if the service is down, sign-up still works.
 */
export async function isBreachedPassword(password: string): Promise<boolean> {
  try {
    const { createHash } = await import("node:crypto");
    const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const suffix = sha1.slice(5);
    return (await res.text()).split("\n").some((line) => {
      const [s, count] = line.trim().split(":");
      return s === suffix && Number(count) > 0;
    });
  } catch {
    return false;
  }
}

async function clientIpHash(): Promise<Buffer | null> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip");
  return ip ? sha256(`${process.env.IP_HASH_SALT ?? ""}:${ip}`) : null;
}

export async function clientKey(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "local";
}

/**
 * Creates a fresh session (new id every sign-in: no session fixation).
 * `embedded`: the Telegram Mini App runs inside web.telegram.org's iframe, where only a
 * SameSite=None, partitioned (CHIPS) cookie is kept. Server Actions still check Origin.
 */
export async function createSession(userId: string, twoFactorPassed: boolean, opts: { embedded?: boolean } = {}) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  const ipHash = await clientIpHash();
  const userAgent = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  await asAuth(getDb(), (tx) =>
    tx.insert(schema.sessions).values({ userId, tokenHash: sha256(token), expiresAt, twoFactorPassed, ipHash, userAgent }),
  );
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: opts.embedded && process.env.NODE_ENV === "production" ? "none" : "lax",
    partitioned: opts.embedded && process.env.NODE_ENV === "production" ? true : undefined,
    path: "/",
    expires: expiresAt,
  });
}

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  locale: string;
  plan: "free" | "pro";
  sessionId: string;
  needsTwoFactor: boolean;
}

/** The signed-in user for this request, or null. Cached per request. */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  const rows = await asAuth(getDb(), async (tx) => {
    const r = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        locale: schema.users.locale,
        plan: schema.users.plan,
        sessionId: schema.sessions.id,
        twoFactorPassed: schema.sessions.twoFactorPassed,
        totpEnabledAt: schema.users.totpEnabledAt,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(
        and(
          eq(schema.sessions.tokenHash, sha256(token)),
          gt(schema.sessions.expiresAt, sql`now()`),
          sql`${schema.users.deletedAt} IS NULL`,
        ),
      );
    return r;
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    locale: row.locale,
    plan: row.plan,
    sessionId: row.sessionId,
    needsTwoFactor: !!row.totpEnabledAt && !row.twoFactorPassed,
  };
});

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await asAuth(getDb(), (tx) => tx.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token))));
  }
  jar.delete(SESSION_COOKIE);
}

export async function markTwoFactorPassed(sessionId: string) {
  await asAuth(getDb(), (tx) =>
    tx.update(schema.sessions).set({ twoFactorPassed: true }).where(eq(schema.sessions.id, sessionId)),
  );
}
