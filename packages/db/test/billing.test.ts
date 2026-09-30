// Phase 5: subscriptions change the plan only through the signed webhook path, the plan is
// computed the same way as in the domain package, a downgrade deletes nothing, and the limits
// hold under concurrent requests also while the plan changes.
import { randomUUID } from "node:crypto";
import { BILLING_CASES } from "@poker/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BillingEvent, applyBillingEvent, expireSubscriptions } from "../src/billing";
import { asAuth, asBilling, asUser } from "../src/client";
import { createGame, createHome } from "../src/repo";
import * as s from "../src/schema";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.close());

const day = 86_400_000;
let clock = Date.now() - 60 * day;

/** A subscription event as the webhook route hands it over (after the signature check). */
function ev(userId: string | null, sub: string, over: Partial<BillingEvent> = {}): BillingEvent {
  clock += 1000;
  return {
    eventId: `evt_${randomUUID()}`,
    eventType: "subscription.updated",
    occurredAt: new Date(clock),
    userId,
    subscriptionId: sub,
    customerId: `ctm_${sub}`,
    status: "active",
    priceId: "pri_month",
    interval: "month",
    periodEnd: new Date(Date.now() + 20 * day),
    cancelAt: null,
    ...over,
  };
}

const apply = (e: BillingEvent) => asBilling(t.db, (tx) => applyBillingEvent(tx, e));

async function plan(u: string) {
  const [r] = await t.admin`SELECT plan FROM users WHERE id = ${u}`;
  return r!.plan as "free" | "pro";
}

async function homesOf(u: string) {
  return (await t.admin`SELECT id, read_only FROM homes WHERE owner_id = ${u} AND deleted_at IS NULL ORDER BY created_at, id`).map(
    (r) => ({ id: r.id as string, ro: r.read_only as boolean }),
  );
}

/** Homes in separate transactions, so "oldest" is well defined. */
async function makeHomes(u: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await asUser(t.db, u, (tx) => createHome(tx, u, { name: `h${i}` }))).id);
  return ids;
}

describe("subscription → plan in the database matches the domain rules", () => {
  it.each(BILLING_CASES)("$name", async (c) => {
    const [r] = await t.admin`SELECT app.subscription_gives_pro(${c.sub.status}, ${c.sub.currentPeriodEnd}, ${c.sub.cancelAt}, ${c.at}) AS pro`;
    expect(r!.pro).toBe(c.pro);
  });
});

describe("webhook events", () => {
  it("created → Pro; past_due → Free; recovered → Pro; canceled at period end → Free", async () => {
    const u = await t.newUser("free");
    const sub = `sub_${randomUUID()}`;
    expect(await apply(ev(u, sub, { eventType: "subscription.created" }))).toBe("applied");
    expect(await plan(u)).toBe("pro");
    await apply(ev(null, sub, { status: "past_due" }));
    expect(await plan(u)).toBe("free");
    await apply(ev(null, sub, { status: "active" }));
    expect(await plan(u)).toBe("pro");
    // Scheduled cancel: still Pro until then.
    const end = new Date(Date.now() + 10 * day);
    await apply(ev(null, sub, { cancelAt: end, periodEnd: end }));
    expect(await plan(u)).toBe("pro");
    // Canceled with the paid period still running (no period in the payload): stays Pro.
    await apply(ev(null, sub, { eventType: "subscription.canceled", status: "canceled", periodEnd: null, cancelAt: new Date() }));
    expect(await plan(u)).toBe("pro");
    const [row] = await t.admin`SELECT status, current_period_end FROM subscriptions WHERE provider_ref = ${sub}`;
    expect(row!.status).toBe("canceled");
    expect((row!.current_period_end as Date).getTime()).toBe(end.getTime());
    // The period runs out without another webhook: the sweep drops Pro.
    await t.admin`UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE provider_ref = ${sub}`;
    expect(await asBilling(t.db, (tx) => expireSubscriptions(tx))).toBeGreaterThanOrEqual(1);
    expect(await plan(u)).toBe("free");
  });

  it("paused → Free, resumed → Pro; trialing is Pro", async () => {
    const u = await t.newUser("free");
    const sub = `sub_${randomUUID()}`;
    await apply(ev(u, sub, { eventType: "subscription.created", status: "trialing" }));
    expect(await plan(u)).toBe("pro");
    await apply(ev(null, sub, { eventType: "subscription.paused", status: "paused", periodEnd: null }));
    expect(await plan(u)).toBe("free");
    await apply(ev(null, sub, { eventType: "subscription.resumed", status: "active" }));
    expect(await plan(u)).toBe("pro");
  });

  it("the same event twice (even at once) is applied once", async () => {
    const u = await t.newUser("free");
    const e = ev(u, `sub_${randomUUID()}`, { eventType: "subscription.created" });
    const results = await Promise.all([1, 2, 3, 4].map(() => apply(e)));
    expect(results.filter((r) => r === "applied")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(3);
    const [{ n }] = (await t.admin`SELECT count(*)::int AS n FROM billing_events WHERE event_id = ${e.eventId}`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it("an older event that arrives late does not overwrite a newer state", async () => {
    const u = await t.newUser("free");
    const sub = `sub_${randomUUID()}`;
    const created = ev(u, sub, { eventType: "subscription.created" });
    const canceled = ev(null, sub, { eventType: "subscription.canceled", status: "canceled", periodEnd: new Date(Date.now() - day) });
    await apply(canceled); // unmapped: no user id and unknown subscription
    await apply(created);
    expect(await plan(u)).toBe("pro");
    const later = ev(null, sub, { status: "past_due" });
    const earlier = { ...ev(null, sub, { status: "active" }), occurredAt: new Date(later.occurredAt.getTime() - 500) };
    await apply(later);
    await apply(earlier);
    expect(await plan(u)).toBe("free");
  });

  it("a payment before the subscription event starts it; unknown users are recorded as unmapped", async () => {
    const u = await t.newUser("free");
    const sub = `sub_${randomUUID()}`;
    await apply(ev(u, sub, { eventType: "transaction.completed", status: null }));
    expect(await plan(u)).toBe("pro");
    const e = ev(randomUUID(), `sub_${randomUUID()}`);
    expect(await apply(e)).toBe("unmapped");
    const [r] = await t.admin`SELECT outcome FROM billing_events WHERE event_id = ${e.eventId}`;
    expect(r!.outcome).toBe("unmapped");
  });

  it("custom_data cannot move a known subscription to another user", async () => {
    const u = await t.newUser("free");
    const other = await t.newUser("free");
    const sub = `sub_${randomUUID()}`;
    await apply(ev(u, sub, { eventType: "subscription.created" }));
    await apply(ev(other, sub));
    expect(await plan(u)).toBe("pro");
    expect(await plan(other)).toBe("free");
  });
});

describe("who may change what", () => {
  it("a user reads only their own subscription and cannot write any", async () => {
    const u = await t.newUser("free");
    const other = await t.newUser("free");
    await apply(ev(u, `sub_${randomUUID()}`, { eventType: "subscription.created" }));
    await apply(ev(other, `sub_${randomUUID()}`, { eventType: "subscription.created" }));
    const mine = await asUser(t.db, u, (tx) => tx.select().from(s.subscriptions));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.userId).toBe(u);
    expect(await pgError(asUser(t.db, u, (tx) => tx.update(s.subscriptions).set({ status: "active" })))).toMatch(/permission denied/);
    expect(
      await pgError(asUser(t.db, u, (tx) => tx.insert(s.subscriptions).values({ userId: u, provider: "paddle", providerRef: "x", status: "active" }))),
    ).toMatch(/permission denied/);
    expect(await pgError(asUser(t.db, u, (tx) => tx.select().from(s.billingEvents)))).toMatch(/permission denied/);
  });

  it("neither the user role nor the sign-in role can set the plan", async () => {
    const u = await t.newUser("free");
    expect(await pgError(asUser(t.db, u, (tx) => tx.update(s.users).set({ plan: "pro" }).where(eq(s.users.id, u))))).toMatch(
      /permission denied/,
    );
    expect(await pgError(asAuth(t.db, (tx) => tx.update(s.users).set({ plan: "pro" }).where(eq(s.users.id, u))))).toMatch(
      /only through billing/,
    );
    expect(await pgError(asAuth(t.db, (tx) => tx.insert(s.users).values({ email: `${randomUUID()}@x.test`, plan: "pro" })))).toMatch(
      /only through billing/,
    );
    // Other columns still work for the sign-in role.
    await asAuth(t.db, (tx) => tx.update(s.users).set({ displayName: "ok" }).where(eq(s.users.id, u)));
    expect(await plan(u)).toBe("free");
  });

  it("only the billing role may call the billing functions, and it can do nothing else", async () => {
    const u = await t.newUser("free");
    expect(await pgError(asUser(t.db, u, (tx) => applyBillingEvent(tx, ev(u, `sub_${randomUUID()}`))))).toMatch(/permission denied/);
    expect(await pgError(asAuth(t.db, (tx) => applyBillingEvent(tx, ev(u, `sub_${randomUUID()}`))))).toMatch(/permission denied/);
    expect(await pgError(asAuth(t.db, (tx) => expireSubscriptions(tx)))).toMatch(/permission denied/);
    expect(await pgError(asBilling(t.db, (tx) => tx.select().from(s.users)))).toMatch(/permission denied/);
    expect(await pgError(asBilling(t.db, (tx) => tx.select().from(s.subscriptions)))).toMatch(/permission denied/);
    expect(await plan(u)).toBe("free");
  });

  it("an owner cannot clear read-only on their home or edit a read-only home", async () => {
    const u = await t.newUser("pro");
    const [, second] = await makeHomes(u, 2);
    await t.admin`UPDATE users SET plan = 'free' WHERE id = ${u}`;
    expect(await pgError(asUser(t.db, u, (tx) => tx.update(s.homes).set({ readOnly: false }).where(eq(s.homes.id, second!))))).toMatch(
      /only through billing/,
    );
    expect(await pgError(asUser(t.db, u, (tx) => tx.update(s.homes).set({ name: "new" }).where(eq(s.homes.id, second!))))).toMatch(
      /read-only/,
    );
    const [first] = await homesOf(u);
    expect(await pgError(asUser(t.db, u, (tx) => tx.update(s.homes).set({ readOnly: true }).where(eq(s.homes.id, first!.id))))).toMatch(
      /only through billing/,
    );
  });
});

describe("downgrade deletes nothing", () => {
  it("oldest home stays writable, the others become read-only, past games stay, re-subscribe restores", async () => {
    const u = await t.newUser("free");
    const sub = `sub_${randomUUID()}`;
    await apply(ev(u, sub, { eventType: "subscription.created" }));
    const [a, b, c] = await makeHomes(u, 3);
    for (const h of [a, b, c, b, c]) await asUser(t.db, u, (tx) => createGame(tx, u, h!));

    await apply(ev(null, sub, { eventType: "subscription.canceled", status: "canceled", periodEnd: new Date(Date.now() - 1000) }));
    expect(await plan(u)).toBe("free");
    expect(await homesOf(u)).toEqual([
      { id: a, ro: false },
      { id: b, ro: true },
      { id: c, ro: true },
    ]);
    // Everything is still there and visible.
    const games = await asUser(t.db, u, (tx) => tx.select({ id: s.games.id }).from(s.games));
    expect(games).toHaveLength(5);
    const homes = await asUser(t.db, u, (tx) => tx.select({ id: s.homes.id }).from(s.homes));
    expect(homes).toHaveLength(3);
    // No new games: read-only home, and the free plan's 3 games are used up.
    expect(await pgError(asUser(t.db, u, (tx) => createGame(tx, u, b!)))).toMatch(/read-only|row-level security/);
    expect(await pgError(asUser(t.db, u, (tx) => createGame(tx, u, a!)))).toMatch(/free plan allows 3 games/);
    // No new home either: the free plan allows one and three exist.
    expect(await pgError(asUser(t.db, u, (tx) => createHome(tx, u, { name: "more" })))).toMatch(/home limit/);

    // Deleting the writable home frees the next oldest.
    await t.admin`UPDATE homes SET deleted_at = now() WHERE id = ${a!}`;
    expect(await homesOf(u)).toEqual([
      { id: b, ro: false },
      { id: c, ro: true },
    ]);

    // Subscribing again makes every home writable.
    await apply(ev(u, `sub_${randomUUID()}`, { eventType: "subscription.created" }));
    expect(await plan(u)).toBe("pro");
    expect((await homesOf(u)).every((h) => !h.ro)).toBe(true);
    await asUser(t.db, u, (tx) => createGame(tx, u, c!));
  });
});

describe("exit gate: limits hold under concurrent requests around plan changes", () => {
  it("a downgrade racing with game creation: nothing lands in a home that just became read-only", async () => {
    const u = await t.newUser("free");
    const sub = `sub_${randomUUID()}`;
    await apply(ev(u, sub, { eventType: "subscription.created" }));
    const [a, b] = await makeHomes(u, 2);

    // The downgrade holds the owner's row while game requests arrive for both homes.
    const downgrade = asBilling(t.db, async (tx) => {
      await applyBillingEvent(tx, ev(null, sub, { status: "past_due" }));
      await tx.execute(sql`SELECT pg_sleep(0.4)`);
    });
    await new Promise((r) => setTimeout(r, 100));
    const creations = await Promise.allSettled(
      [a, b, a, b, a, b, a, b, a, b].map((h) => asUser(t.db, u, (tx) => createGame(tx, u, h!))),
    );
    await downgrade;

    expect(await plan(u)).toBe("free");
    const counts = await t.admin`SELECT home_id, count(*)::int AS n FROM games WHERE home_id IN (${a!}, ${b!}) GROUP BY home_id`;
    const n = new Map(counts.map((r) => [r.home_id as string, r.n as number]));
    expect(n.get(b!) ?? 0).toBe(0);
    expect(n.get(a!)).toBe(3);
    expect(creations.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });

  it("many rounds of up- and downgrades racing with game creation never break the limits", async () => {
    const u = await t.newUser("free");
    const sub = `sub_${randomUUID()}`;
    const [a, b] = await makeHomes(u, 1).then(async (x) => {
      await apply(ev(u, sub, { eventType: "subscription.created" }));
      return [...x, ...(await makeHomes(u, 1))];
    });
    for (let round = 0; round < 6; round++) {
      const status = round % 2 === 0 ? ("past_due" as const) : ("active" as const);
      await Promise.allSettled([
        apply(ev(null, sub, { status })),
        ...[a, b, a, b].map((h) => asUser(t.db, u, (tx) => createGame(tx, u, h!))),
      ]);
      // Invariant after every round: the flags match the plan, and on Free no home but the
      // oldest is writable.
      const p = await plan(u);
      const hs = await homesOf(u);
      expect(hs.map((h) => h.ro)).toEqual(p === "pro" ? [false, false] : [false, true]);
    }
    // Every game in the second home was created while the owner was Pro: each of them sits
    // in a round whose downgrade had not committed yet. On Free now, none can be added.
    expect(await plan(u)).toBe("pro");
    await apply(ev(null, sub, { status: "past_due" }));
    const before = await t.admin`SELECT count(*)::int AS n FROM games WHERE home_id = ${b!}`;
    await Promise.allSettled([1, 2, 3].map(() => asUser(t.db, u, (tx) => createGame(tx, u, b!))));
    const after = await t.admin`SELECT count(*)::int AS n FROM games WHERE home_id = ${b!}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("an upgrade racing with game creation at the free limit", async () => {
    const u = await t.newUser("free");
    const [a] = await makeHomes(u, 1);
    for (let i = 0; i < 3; i++) await asUser(t.db, u, (tx) => createGame(tx, u, a!));
    const upgrade = asBilling(t.db, async (tx) => {
      await applyBillingEvent(tx, ev(u, `sub_${randomUUID()}`, { eventType: "subscription.created" }));
      await tx.execute(sql`SELECT pg_sleep(0.3)`);
    });
    await new Promise((r) => setTimeout(r, 100));
    // These wait for the upgrade to commit, then see Pro.
    const results = await Promise.allSettled([1, 2, 3].map(() => asUser(t.db, u, (tx) => createGame(tx, u, a!))));
    await upgrade;
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
