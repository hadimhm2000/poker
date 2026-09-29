// Phase 1 exit gate: a closed game does not change even with direct database access,
// and two simultaneous clicks create one record.
import { randomUUID } from "node:crypto";
import { type HashableGame, verifyChain } from "@poker/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser } from "../src/client.js";
import { DomainError, addPlayer, addToGame, closeGame, createGame, createHome, ledger, rebuy, setCashOut } from "../src/repo.js";
import * as s from "../src/schema.js";
import { type TestDb, freshDb, pgError } from "./helpers.js";

let t: TestDb;
let host: string;
let homeId: string;
let pA: string;
let pB: string;
let pC: string;

async function version(gameId: string) {
  const [g] = await t.admin`SELECT version FROM games WHERE id = ${gameId}`;
  return g!.version as number;
}

async function readyGame(outs: [number, number, number] = [0, 250, 50]) {
  return asUser(t.db, host, async (tx) => {
    const g = await createGame(tx, host, homeId, 100);
    for (const p of [pA, pB, pC]) await addToGame(tx, host, g.id, p);
    await setCashOut(tx, host, g.id, pA, outs[0]);
    await setCashOut(tx, host, g.id, pB, outs[1]);
    await setCashOut(tx, host, g.id, pC, outs[2]);
    return g.id;
  });
}

beforeAll(async () => {
  t = await freshDb();
  host = await t.newUser("pro");
  await asUser(t.db, host, async (tx) => {
    homeId = (await createHome(tx, host, { name: "Home" })).id;
    pA = (await addPlayer(tx, homeId, "A")).id;
    pB = (await addPlayer(tx, homeId, "B")).id;
    pC = (await addPlayer(tx, homeId, "C")).id;
  });
});
afterAll(() => t.close());

describe("closing", () => {
  it("refuses while numbers do not balance, naming the problem", async () => {
    const g = await readyGame([0, 250, 40]);
    const err = await asUser(t.db, host, (tx) => closeGame(tx, host, { gameId: g, closeKey: randomUUID(), expectedVersion: 1_000 })).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("STALE");
    const err2 = await asUser(t.db, host, async (tx) =>
      closeGame(tx, host, { gameId: g, closeKey: randomUUID(), expectedVersion: await version(g) }),
    ).catch((e) => e);
    expect(err2.code).toBe("BLOCKED");
    expect(err2.details).toEqual([{ code: "UNBALANCED", totalIn: 300, totalOut: 290, difference: -10 }]);
  });

  it("two simultaneous clicks with the same key create one record", async () => {
    const g = await readyGame();
    const v = await version(g);
    const key = randomUUID();
    const results = await Promise.all(
      [1, 2, 3].map(() => asUser(t.db, host, (tx) => closeGame(tx, host, { gameId: g, closeKey: key, expectedVersion: v }))),
    );
    expect(results.filter((r) => !r.alreadyClosed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.hash)).size).toBe(1);
    const [{ n }] = (await t.admin`SELECT count(*)::int AS n FROM settlements WHERE game_id = ${g}`) as unknown as [{ n: number }];
    expect(n).toBe(2);
  });

  it("two devices with different keys: one closes, the other is told it is closed", async () => {
    const g = await readyGame();
    const v = await version(g);
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((k) => asUser(t.db, host, (tx) => closeGame(tx, host, { gameId: g, closeKey: k, expectedVersion: v }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("FROZEN");
  });

  it("a change after the summary makes the old close request stale", async () => {
    const g = await readyGame();
    const v = await version(g);
    await asUser(t.db, host, (tx) => setCashOut(tx, host, g, pC, 50));
    const err = await asUser(t.db, host, (tx) => closeGame(tx, host, { gameId: g, closeKey: randomUUID(), expectedVersion: v })).catch((e) => e);
    expect(err.code).toBe("STALE");
  });
});

describe("a closed game is frozen", () => {
  let g: string;
  beforeAll(async () => {
    g = await readyGame();
    await asUser(t.db, host, async (tx) => closeGame(tx, host, { gameId: g, closeKey: randomUUID(), expectedVersion: await version(g) }));
  });

  it("the host cannot change it through the app", async () => {
    expect(await pgError(asUser(t.db, host, (tx) => setCashOut(tx, host, g, pA, 10)))).toMatch(/closed/);
    expect(await pgError(asUser(t.db, host, (tx) => rebuy(tx, host, g, pA, 10)))).toMatch(/closed/);
    expect(await pgError(asUser(t.db, host, (tx) => tx.update(s.gameEntries).set({ cashOut: 1 }).where(eq(s.gameEntries.gameId, g))))).toMatch(/closed and cannot be changed/);
    // Deleting a non-draft game is filtered out by RLS before the trigger even runs.
    expect(await asUser(t.db, host, (tx) => tx.delete(s.games).where(eq(s.games.id, g)).returning())).toEqual([]);
    expect(await pgError(asUser(t.db, host, (tx) => tx.update(s.games).set({ number: 7 }).where(eq(s.games.id, g))))).toMatch(/closed and cannot be changed/);
  });

  it("not even with direct database access", async () => {
    const attempts = [
      t.admin`UPDATE games SET number = 99 WHERE id = ${g}`,
      t.admin`UPDATE games SET status = 'live' WHERE id = ${g}`,
      t.admin`DELETE FROM games WHERE id = ${g}`,
      t.admin`UPDATE game_entries SET cash_out = 0 WHERE game_id = ${g}`,
      t.admin`DELETE FROM game_entries WHERE game_id = ${g}`,
      t.admin`INSERT INTO game_entries(game_id, player_id, total_in) VALUES (${g}, ${pA}, 1)`,
      t.admin`UPDATE settlements SET amount = 1 WHERE game_id = ${g}`,
      t.admin`DELETE FROM settlements WHERE game_id = ${g}`,
      t.admin`INSERT INTO game_events(game_id, type, actor_id) VALUES (${g}, 'rebuy', ${host})`,
    ];
    for (const a of attempts) expect(await pgError(a)).toMatch(/closed and cannot be changed/);
  });

  it("the audit log is append-only, even for the database owner", async () => {
    const [{ n }] = (await t.admin`SELECT count(*)::int AS n FROM audit_log`) as unknown as [{ n: number }];
    expect(n).toBeGreaterThan(0);
    expect(await pgError(t.admin`UPDATE audit_log SET action = 'x'`)).toMatch(/append-only/);
    expect(await pgError(t.admin`DELETE FROM audit_log`)).toMatch(/append-only/);
    expect(await pgError(t.admin`TRUNCATE audit_log`)).toMatch(/append-only/);
  });

  it("the hash chain verifies, and detects tampering done with triggers disabled", async () => {
    const load = async () => {
      const rows = await t.admin`SELECT g.id, g.number, g.closed_at, g.hash, g.prev_hash, h.currency, h.id AS home_id FROM games g JOIN homes h ON h.id = g.home_id WHERE g.home_id = ${homeId} AND g.status = 'closed' ORDER BY g.number`;
      const links = [];
      for (const r of rows) {
        const entries = await t.admin`SELECT player_id, total_in, cash_out FROM game_entries WHERE game_id = ${r.id}`;
        const game: HashableGame = {
          homeId: r.home_id,
          number: r.number,
          closedAt: new Date(r.closed_at).toISOString(),
          currency: r.currency,
          entries: entries.map((e) => ({ playerId: e.player_id, totalIn: Number(e.total_in), cashOut: Number(e.cash_out) })),
        };
        links.push({ game, prevHash: r.prev_hash, hash: r.hash });
      }
      return links;
    };
    const links = await load();
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(links.map((l) => l.game.number)).toEqual(links.map((_, i) => i + 1));
    expect(await verifyChain(links)).toBe(-1);

    // Someone with superuser rights bypasses the triggers...
    await t.admin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE game_entries SET cash_out = cash_out + 10 WHERE game_id = ${g} AND player_id = ${pA}`;
      await tx`UPDATE game_entries SET cash_out = cash_out - 10 WHERE game_id = ${g} AND player_id = ${pB}`;
    });
    // ...and the chain shows exactly which game was altered.
    const tampered = await load();
    const broken = await verifyChain(tampered);
    expect(broken).toBeGreaterThanOrEqual(0);
    const [altered] = await t.admin`SELECT number FROM games WHERE id = ${g}`;
    expect(tampered[broken]!.game.number).toBe(altered!.number);
  });
});

describe("debts carry forward and net out", () => {
  it("last game's open debt is netted into the next settlement", async () => {
    const h = await t.newUser("pro");
    let home = "";
    let a = "";
    let b = "";
    await asUser(t.db, h, async (tx) => {
      home = (await createHome(tx, h, { name: "Carry" })).id;
      a = (await addPlayer(tx, home, "a")).id;
      b = (await addPlayer(tx, home, "b")).id;
    });
    const play = async (outA: number, outB: number) =>
      asUser(t.db, h, async (tx) => {
        const g = await createGame(tx, h, home, 100);
        await addToGame(tx, h, g.id, a);
        await addToGame(tx, h, g.id, b);
        await setCashOut(tx, h, g.id, a, outA);
        await setCashOut(tx, h, g.id, b, outB);
        const [cur] = await tx.select().from(s.games).where(eq(s.games.id, g.id));
        return closeGame(tx, h, { gameId: g.id, closeKey: randomUUID(), expectedVersion: cur!.version });
      });
    const first = await play(0, 200); // a owes b 100
    expect(first.transfers).toEqual([{ from: a, to: b, amount: 100 }]);
    const second = await play(160, 40); // b owes a 60 → net: a owes b 40
    expect(second.transfers).toEqual([{ from: a, to: b, amount: 40 }]);
    await asUser(t.db, h, async (tx) => {
      const open = await ledger(tx, home);
      expect(open.map((d) => d.amount)).toEqual([40]);
    });
  });
});

describe("plan limits hold under concurrent requests", () => {
  it("free plan: one home", async () => {
    const u = await t.newUser("free");
    const results = await Promise.allSettled([1, 2, 3].map((i) => asUser(t.db, u, (tx) => createHome(tx, u, { name: `h${i}` }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("free plan: three games in total, even when five are created at once", async () => {
    const u = await t.newUser("free");
    const home = await asUser(t.db, u, (tx) => createHome(tx, u, { name: "free" }));
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => asUser(t.db, u, (tx) => createGame(tx, u, home.id))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const reason = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
    expect(`${reason.message} ${reason.cause?.message}`).toMatch(/free plan allows 3 games/);
  });

  it("pro plan: five homes", async () => {
    const u = await t.newUser("pro");
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6, 7].map((i) => asUser(t.db, u, (tx) => createHome(tx, u, { name: `h${i}` }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  });
});
