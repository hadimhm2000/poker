// Phase 4 rest: seasons, house rules, result card data and public verification.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAuth, asUser } from "../src/client";
import { addPlayer, addToGame, closeGame, createGame, createHome, setCashOut } from "../src/repo";
import { createSeason, deleteSeason, listSeasons, resultCard, seasonPeriod, setHouseRules, verifyByHash } from "../src/seasons";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
let host: string;
let member: string;
let stranger: string;
let homeId: string;
const hashes: string[] = [];
const gameIds: string[] = [];

beforeAll(async () => {
  t = await freshDb();
  host = await t.newUser("pro");
  member = await t.newUser("free");
  stranger = await t.newUser("free");
  await asUser(t.db, host, async (tx) => {
    homeId = (await createHome(tx, host, { name: "Friday", currency: "EUR" })).id;
    const a = (await addPlayer(tx, homeId, "Ali")).id;
    const b = (await addPlayer(tx, homeId, "Sara")).id;
    for (const [outA, outB] of [
      [300, 100],
      [0, 400],
    ]) {
      const g = await createGame(tx, host, homeId, 200);
      await addToGame(tx, host, g.id, a);
      await addToGame(tx, host, g.id, b);
      await setCashOut(tx, host, g.id, a, outA!);
      await setCashOut(tx, host, g.id, b, outB!);
      const [v] = await tx.execute<{ version: number }>(sql`SELECT version FROM games WHERE id = ${g.id}`);
      const r = await closeGame(tx, host, { gameId: g.id, closeKey: randomUUID(), expectedVersion: v!.version });
      hashes.push(r.hash);
      gameIds.push(g.id);
    }
  });
  await t.admin`INSERT INTO home_members(home_id, user_id, role) VALUES (${homeId}, ${member}, 'member')`;
});
afterAll(() => t.close());

describe("seasons", () => {
  it("the host makes one, members see it, others cannot", async () => {
    const s = await asUser(t.db, host, (tx) => createSeason(tx, host, { homeId, name: "Mehr", startsOn: "2026-09-23", endsOn: "2026-10-22" }));
    expect((await asUser(t.db, member, (tx) => listSeasons(tx, homeId))).map((x) => x.name)).toEqual(["Mehr"]);
    expect(await asUser(t.db, stranger, (tx) => listSeasons(tx, homeId))).toEqual([]);
    expect(await pgError(asUser(t.db, member, (tx) => createSeason(tx, member, { homeId, name: "X", startsOn: "2026-01-01" })))).toMatch(
      /row-level security/,
    );
    expect(await pgError(asUser(t.db, member, (tx) => deleteSeason(tx, s.id)))).toMatch(/NOT_FOUND/);
    await asUser(t.db, host, (tx) => deleteSeason(tx, s.id));
    expect(await asUser(t.db, host, (tx) => listSeasons(tx, homeId))).toEqual([]);
  });

  it("an end before the start is refused", async () => {
    expect(
      await pgError(asUser(t.db, host, (tx) => createSeason(tx, host, { homeId, name: "Bad", startsOn: "2026-02-01", endsOn: "2026-01-01" }))),
    ).toMatch(/end before start/);
  });

  it("the last day is included", () => {
    const p = seasonPeriod({ startsOn: "2026-09-23", endsOn: "2026-10-22" });
    expect(p.start.toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(p.end!.toISOString()).toBe("2026-10-23T00:00:00.000Z");
    expect(seasonPeriod({ startsOn: "2026-09-23", endsOn: null }).end).toBeNull();
  });
});

describe("house rules", () => {
  it("only the host writes them", async () => {
    await asUser(t.db, host, (tx) => setHouseRules(tx, homeId, "Rebuy cap: 3\r\nNo phones at the table"));
    const [h] = await t.admin`SELECT house_rules FROM homes WHERE id = ${homeId}`;
    expect(h!.house_rules).toBe("Rebuy cap: 3\nNo phones at the table");
    expect(await pgError(asUser(t.db, member, (tx) => setHouseRules(tx, homeId, "mine now")))).toMatch(/NOT_FOUND/);
    expect(await pgError(asUser(t.db, host, (tx) => setHouseRules(tx, homeId, "x".repeat(2001))))).toMatch(/2000/);
  });
});

describe("result card", () => {
  it("members get the card data, sorted by result", async () => {
    const c = await asUser(t.db, member, (tx) => resultCard(tx, gameIds[1]!));
    expect(c.number).toBe(2);
    expect(c.rows.map((r) => [r.name, r.net])).toEqual([
      ["Sara", 200],
      ["Ali", -200],
    ]);
    expect(c.transfers).toHaveLength(1);
    expect(c.hash).toBe(hashes[1]);
  });

  it("strangers get nothing", async () => {
    expect(await pgError(asUser(t.db, stranger, (tx) => resultCard(tx, gameIds[1]!)))).toMatch(/NOT_FOUND/);
  });
});

describe("verification by the QR hash", () => {
  it("anyone with the hash sees that game, verified with its whole chain", async () => {
    const v = await asAuth(t.db, (tx) => verifyByHash(tx, hashes[1]!));
    expect(v).not.toBeNull();
    expect(v!.number).toBe(2);
    expect(v!.gameIntact).toBe(true);
    expect(v!.chainIntact).toBe(true);
    expect(v!.chainLength).toBe(2);
    expect(v!.prevHash).toBe(hashes[0]);
    expect(v!.entries.map((e) => e.name)).toEqual(["Sara", "Ali"]);
    // The shown payload really is what was hashed.
    expect(createHash("sha256").update(`${v!.prevHash}\n${v!.payload}`).digest("hex")).toBe(hashes[1]);
  });

  it("an unknown or malformed hash finds nothing", async () => {
    expect(await asAuth(t.db, (tx) => verifyByHash(tx, "0".repeat(64)))).toBeNull();
    expect(await asAuth(t.db, (tx) => verifyByHash(tx, "not-a-hash"))).toBeNull();
  });

  it("a result changed behind the freeze is caught, and so is every later game", async () => {
    // Someone with superuser access bypasses the freeze trigger and edits game 1.
    await t.admin.begin(async (sql) => {
      await sql`ALTER TABLE game_entries DISABLE TRIGGER USER`;
      await sql`UPDATE game_entries SET cash_out = cash_out + 50 WHERE game_id = ${gameIds[0]!} AND cash_out = 300`;
      await sql`ALTER TABLE game_entries ENABLE TRIGGER USER`;
    });
    const first = await asAuth(t.db, (tx) => verifyByHash(tx, hashes[0]!));
    expect(first!.gameIntact).toBe(false);
    const second = await asAuth(t.db, (tx) => verifyByHash(tx, hashes[1]!));
    expect(second!.gameIntact).toBe(true);
    expect(second!.chainIntact).toBe(false);
  });
});
