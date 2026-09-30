// Limited admin: support access is time-boxed, needs a reason, and every step is logged.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminEndSessions,
  adminFindUsers,
  adminOpenHome,
  adminOverview,
  adminRecent,
  adminSetPlan,
  adminViewHome,
} from "../src/admin";
import { asAuth, asUser } from "../src/client";
import { addPlayer, createHome } from "../src/repo";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
let admin = "";
let host = "";
let homeId = "";

beforeAll(async () => {
  t = await freshDb();
  admin = await t.newUser("free");
  host = await t.newUser("free");
  await t.admin`UPDATE users SET email = 'host-admin-test@example.com' WHERE id = ${host}`;
  await asUser(t.db, host, async (tx) => {
    homeId = (await createHome(tx, host, { name: "Friday" })).id;
    await addPlayer(tx, homeId, "Abol");
  });
});
afterAll(() => t.close());

describe("admin", () => {
  it("overview and search give counts, not game data", async () => {
    const o = await asAuth(t.db, (tx) => adminOverview(tx, admin));
    expect(o.users).toBeGreaterThanOrEqual(2);
    expect(o.homes).toBeGreaterThanOrEqual(1);
    const found = await asAuth(t.db, (tx) => adminFindUsers(tx, admin, "host-admin"));
    expect(found.map((u) => u.email)).toEqual(["host-admin-test@example.com"]);
    expect(found[0]!.homes_owned).toBe(1);
    // Too short a query finds nothing; LIKE wildcards are not wildcards.
    expect(await asAuth(t.db, (tx) => adminFindUsers(tx, admin, "ho"))).toEqual([]);
    expect(await asAuth(t.db, (tx) => adminFindUsers(tx, admin, "%%%"))).toEqual([]);
  });

  it("a home opens only with a reason, for one hour, and each view is logged", async () => {
    expect(await pgError(asAuth(t.db, (tx) => adminViewHome(tx, admin, homeId)))).toMatch(/no open support access/);
    expect(await pgError(asAuth(t.db, (tx) => adminOpenHome(tx, admin, homeId, "hi")))).toMatch(/reason/);
    const until = await asAuth(t.db, (tx) => adminOpenHome(tx, admin, homeId, "Ticket 42: wrong total"));
    expect(until.getTime() - Date.now()).toBeGreaterThan(55 * 60e3);
    const v = await asAuth(t.db, (tx) => adminViewHome(tx, admin, homeId));
    expect([v.name, v.players, v.owner]).toEqual(["Friday", 1, "host-admin-test@example.com"]);
    // Another admin has no access through this grant; an expired grant is closed.
    const other = await t.newUser("free");
    expect(await pgError(asAuth(t.db, (tx) => adminViewHome(tx, other, homeId)))).toMatch(/no open support access/);
    await t.admin`UPDATE support_grants SET expires_at = now() - interval '1 minute'`;
    expect(await pgError(asAuth(t.db, (tx) => adminViewHome(tx, admin, homeId)))).toMatch(/no open support access/);
    const log = await asAuth(t.db, (tx) => adminRecent(tx, admin));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["admin:open_home", "admin:view_home", "admin:find_users"]));
  });

  it("plan changes and ending sessions need a reason and are logged", async () => {
    expect(await pgError(asAuth(t.db, (tx) => adminSetPlan(tx, admin, host, "pro", "")))).toMatch(/reason/);
    await asAuth(t.db, (tx) => adminSetPlan(tx, admin, host, "pro", "Paid by bank transfer"));
    const [u] = await t.admin`SELECT plan FROM users WHERE id = ${host}`;
    expect(u!.plan).toBe("pro");
    await t.admin`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${host}, '\\x01', now() + interval '1 day')`;
    expect(await asAuth(t.db, (tx) => adminEndSessions(tx, admin, host, "Lost phone, ticket 43"))).toBe(1);
    const [a] = await t.admin`SELECT details FROM audit_log WHERE action = 'admin:set_plan' ORDER BY id DESC LIMIT 1`;
    expect(a!.details).toMatchObject({ plan: "pro", reason: "Paid by bank transfer" });
  });

  it("request handlers cannot call the admin functions or read grants", async () => {
    expect(await pgError(asUser(t.db, host, (tx) => adminOverview(tx, host)))).toMatch(/permission denied/);
    expect(await pgError(asUser(t.db, host, (tx) => tx.execute(sql`SELECT * FROM support_grants`)))).toMatch(/permission denied/);
  });
});
