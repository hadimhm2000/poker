// Account module: recovery codes, email links, Google/Apple identities, deletion.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  consumeEmailToken,
  createEmailToken,
  deleteAccount,
  linkIdentity,
  markEmailVerified,
  oidcSignIn,
  recoveryCodesLeft,
  resetPassword,
  setRecoveryCodes,
  unlinkIdentity,
  useRecoveryCode,
} from "../src/accounts";
import { asAuth, asUser } from "../src/client";
import { addPlayer, addToGame, closeGame, createGame, createHome, setCashOut } from "../src/repo";
import { userIdentities } from "../src/schema";
import { verifyByHash } from "../src/seasons";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
const sha = (s: string) => createHash("sha256").update(s).digest();

beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.close());

async function userWith(email: string, verified: boolean, password = true) {
  const [u] = await t.admin`
    INSERT INTO users (email, email_verified_at, password_hash, display_name)
    VALUES (${email}, ${verified ? new Date() : null}, ${password ? "x" : null}, 'U') RETURNING id`;
  return u!.id as string;
}

describe("recovery codes", () => {
  it("each works once, even when two devices race", async () => {
    const u = await userWith("rc@example.com", true);
    await asAuth(t.db, (tx) => setRecoveryCodes(tx, u, [sha("aaaa"), sha("bbbb")]));
    const race = await Promise.all([1, 2].map(() => asAuth(t.db, (tx) => useRecoveryCode(tx, u, sha("aaaa")))));
    expect(race.filter(Boolean)).toHaveLength(1);
    expect(await asAuth(t.db, (tx) => useRecoveryCode(tx, u, sha("aaaa")))).toBe(false);
    expect(await asAuth(t.db, (tx) => useRecoveryCode(tx, u, sha("nope")))).toBe(false);
    expect(await asAuth(t.db, (tx) => recoveryCodesLeft(tx, u))).toBe(1);
    // New codes replace the old ones.
    await asAuth(t.db, (tx) => setRecoveryCodes(tx, u, [sha("cccc")]));
    expect(await asAuth(t.db, (tx) => useRecoveryCode(tx, u, sha("bbbb")))).toBe(false);
  });

  it("request handlers cannot read them", async () => {
    const u = await userWith("rc2@example.com", true);
    expect(await pgError(asUser(t.db, u, (tx) => tx.execute(sql`SELECT * FROM recovery_codes`)))).toMatch(
      /permission denied/,
    );
  });
});

describe("email links", () => {
  it("verify once, only for the address it was sent to", async () => {
    const u = await userWith("v@example.com", false);
    await asAuth(t.db, (tx) => createEmailToken(tx, { hash: sha("v1"), userId: u, purpose: "verify", email: "v@example.com", ttlMs: 60e3 }));
    expect(await asAuth(t.db, (tx) => consumeEmailToken(tx, sha("v1"), "reset"))).toBeNull();
    const ok = await asAuth(t.db, (tx) => consumeEmailToken(tx, sha("v1"), "verify"));
    expect(ok?.userId).toBe(u);
    expect(await asAuth(t.db, (tx) => consumeEmailToken(tx, sha("v1"), "verify"))).toBeNull();
    await asAuth(t.db, (tx) => markEmailVerified(tx, u));
    const [row] = await t.admin`SELECT email_verified_at FROM users WHERE id = ${u}`;
    expect(row!.email_verified_at).not.toBeNull();

    // A link for an address the account no longer has is refused.
    await asAuth(t.db, (tx) => createEmailToken(tx, { hash: sha("v2"), userId: u, purpose: "verify", email: "v@example.com", ttlMs: 60e3 }));
    await t.admin`UPDATE users SET email = 'new@example.com' WHERE id = ${u}`;
    expect(await asAuth(t.db, (tx) => consumeEmailToken(tx, sha("v2"), "verify"))).toBeNull();
  });

  it("expired links and replaced links fail", async () => {
    const u = await userWith("r@example.com", false);
    await asAuth(t.db, (tx) => createEmailToken(tx, { hash: sha("old"), userId: u, purpose: "reset", email: "r@example.com", ttlMs: 60e3 }));
    await asAuth(t.db, (tx) => createEmailToken(tx, { hash: sha("new"), userId: u, purpose: "reset", email: "r@example.com", ttlMs: 60e3 }));
    expect(await asAuth(t.db, (tx) => consumeEmailToken(tx, sha("old"), "reset"))).toBeNull();
    await asAuth(t.db, (tx) => createEmailToken(tx, { hash: sha("exp"), userId: u, purpose: "reset", email: "r@example.com", ttlMs: -1 }));
    expect(await asAuth(t.db, (tx) => consumeEmailToken(tx, sha("exp"), "reset"))).toBeNull();
  });

  it("a password reset ends every session", async () => {
    const u = await userWith("s@example.com", false);
    await t.admin`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${u}, ${sha(randomUUID())}, now() + interval '1 day')`;
    await asAuth(t.db, (tx) => resetPassword(tx, u, "newhash"));
    const [n] = await t.admin`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${u}`;
    expect(n!.n).toBe(0);
    const [row] = await t.admin`SELECT password_hash, email_verified_at FROM users WHERE id = ${u}`;
    expect(row!.password_hash).toBe("newhash");
    expect(row!.email_verified_at).not.toBeNull();
  });
});

describe("Google and Apple", () => {
  const google = (subject: string, email: string | null, emailVerified = true) =>
    ({ provider: "google", subject, email, emailVerified, name: "Sara" }) as const;

  it("creates an account, then signs the same identity in again", async () => {
    const a = await asAuth(t.db, (tx) => oidcSignIn(tx, google("g-1", "sara@example.com"), "fa"));
    expect(a.created).toBe(true);
    const b = await asAuth(t.db, (tx) => oidcSignIn(tx, google("g-1", "sara@example.com"), "fa"));
    expect(b).toEqual({ userId: a.userId, created: false });
    const [u] = await t.admin`SELECT email_verified_at, display_name, locale, password_hash FROM users WHERE id = ${a.userId}`;
    expect(u!.email_verified_at).not.toBeNull();
    expect([u!.display_name, u!.locale, u!.password_hash]).toEqual(["Sara", "fa", null]);
  });

  it("links to an existing account only when both sides verified the email", async () => {
    const verified = await userWith("both@example.com", true);
    const r = await asAuth(t.db, (tx) => oidcSignIn(tx, google("g-2", "Both@Example.com"), "en"));
    expect(r).toEqual({ userId: verified, created: false });

    await userWith("unverified@example.com", false);
    expect(await pgError(asAuth(t.db, (tx) => oidcSignIn(tx, google("g-3", "unverified@example.com"), "en")))).toMatch(/EMAIL_IN_USE/);
    await userWith("claim@example.com", true);
    expect(await pgError(asAuth(t.db, (tx) => oidcSignIn(tx, google("g-4", "claim@example.com", false), "en")))).toMatch(/EMAIL_IN_USE/);
  });

  it("link and unlink from the security page, never the last login", async () => {
    const u = await userWith("link@example.com", true, false);
    await asAuth(t.db, (tx) => linkIdentity(tx, u, { provider: "apple", subject: "a-1", email: null, emailVerified: false, name: null }));
    // Someone else's Apple ID cannot be attached.
    const other = await userWith("other@example.com", true);
    expect(
      await pgError(asAuth(t.db, (tx) => linkIdentity(tx, other, { provider: "apple", subject: "a-1", email: null, emailVerified: false, name: null }))),
    ).toMatch(/IDENTITY_TAKEN/);
    // No password, no Telegram: Apple is the only way in.
    expect(await pgError(asAuth(t.db, (tx) => unlinkIdentity(tx, u, "apple")))).toMatch(/LAST_LOGIN/);
    await asAuth(t.db, (tx) => linkIdentity(tx, u, google("g-5", "link@example.com")));
    await asAuth(t.db, (tx) => unlinkIdentity(tx, u, "apple"));
    // The user sees their own logins only.
    const ids = await asUser(t.db, u, (tx) => tx.select({ p: userIdentities.provider }).from(userIdentities));
    expect(ids.map((i) => i.p)).toEqual(["google"]);
  });
});

describe("deleting an account", () => {
  it("removes personal data, keeps frozen games verifiable under a new name", async () => {
    const host = await t.newUser("pro");
    const leaver = await t.newUser("free");
    let gameHash = "";
    let leaverPlayer = "";
    let homeId = "";
    let a = "";
    await asUser(t.db, host, async (tx) => {
      homeId = (await createHome(tx, host, { name: "H" })).id;
      a = (await addPlayer(tx, homeId, "Host")).id;
      leaverPlayer = (await addPlayer(tx, homeId, "Leaver")).id;
    });
    await t.admin`INSERT INTO home_members (home_id, user_id, role) VALUES (${homeId}, ${leaver}, 'member')`;
    await t.admin`UPDATE players SET user_id = ${leaver} WHERE id = ${leaverPlayer}`;
    await asUser(t.db, host, async (tx) => {
      const g = await createGame(tx, host, homeId, 100);
      await addToGame(tx, host, g.id, a);
      await addToGame(tx, host, g.id, leaverPlayer);
      await setCashOut(tx, host, g.id, a, 150);
      await setCashOut(tx, host, g.id, leaverPlayer, 50);
      const [v] = await tx.execute<{ version: number }>(sql`SELECT version FROM games WHERE id = ${g.id}`);
      gameHash = (await closeGame(tx, host, { gameId: g.id, closeKey: randomUUID(), expectedVersion: v!.version })).hash;
    });
    await t.admin`UPDATE users SET email = 'leaver@example.com' WHERE id = ${leaver}`;
    await asAuth(t.db, (tx) => deleteAccount(tx, leaver));

    const [u] = await t.admin`SELECT email, password_hash, display_name, deleted_at FROM users WHERE id = ${leaver}`;
    expect([u!.email, u!.password_hash, u!.display_name]).toEqual([null, null, ""]);
    expect(u!.deleted_at).not.toBeNull();
    const [p] = await t.admin`SELECT display_name, user_id FROM players WHERE id = ${leaverPlayer}`;
    expect(p!.user_id).toBeNull();
    expect(p!.display_name).toMatch(/^Deleted /);
    const [m] = await t.admin`SELECT count(*)::int AS n FROM home_members WHERE user_id = ${leaver}`;
    expect(m!.n).toBe(0);
    // The result card still verifies; the name shown is the new one.
    const v = await asAuth(t.db, (tx) => verifyByHash(tx, gameHash));
    expect(v!.gameIntact && v!.chainIntact).toBe(true);
    expect(v!.entries.map((e) => e.name)).not.toContain("Leaver");
    // Deleting twice is refused.
    expect(await pgError(asAuth(t.db, (tx) => deleteAccount(tx, leaver)))).toMatch(/not found/);
  });

  it("request handlers cannot call it", async () => {
    const u = await t.newUser("free");
    expect(await pgError(asUser(t.db, u, (tx) => deleteAccount(tx, u)))).toMatch(/permission denied/);
  });
});
