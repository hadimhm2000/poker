import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser } from "../src/client";
import { addPlayer, createHome, importGame, ledger, resultRows } from "../src/repo";
import { type TestDb, freshDb } from "./helpers";

let t: TestDb;
let u: string;
let home: string;

beforeAll(async () => {
  t = await freshDb();
  u = await t.newUser("pro");
  await asUser(t.db, u, async (tx) => {
    home = (await createHome(tx, u, { name: "Old sheet" })).id;
    await addPlayer(tx, home, "Abol");
  });
});
afterAll(() => t.close());

describe("importing old games", () => {
  it("reuses players by name (case-insensitive), creates missing ones, closes with the original date", async () => {
    const r = await asUser(t.db, u, (tx) =>
      importGame(tx, u, {
        homeId: home,
        playedAt: "2025-03-14T20:00:00Z",
        rows: [
          { name: "abol", totalIn: 500, cashOut: 1200 },
          { name: "Sara", totalIn: 700, cashOut: 0 },
          { name: "Reza", totalIn: 0, cashOut: 0 },
        ],
      }),
    );
    expect(r.number).toBe(1);
    const rows = await asUser(t.db, u, (tx) => resultRows(tx, home));
    expect(rows.map((x) => [x.name, x.cashOut - x.totalIn]).sort()).toEqual([["Abol", 700], ["Reza", 0], ["Sara", -700]]);
    expect(rows[0]!.closedAt.toISOString()).toBe("2025-03-14T20:00:00.000Z");
  });

  it("old settlements do not appear as open debts", async () => {
    expect(await asUser(t.db, u, (tx) => ledger(tx, home))).toEqual([]);
  });

  it("an unbalanced imported game is rejected and nothing is written", async () => {
    await expect(
      asUser(t.db, u, (tx) =>
        importGame(tx, u, { homeId: home, playedAt: "2025-03-21", rows: [{ name: "Abol", totalIn: 500, cashOut: 400 }, { name: "Sara", totalIn: 500, cashOut: 500 }] }),
      ),
    ).rejects.toThrow(/cannot be closed/);
    const [{ n }] = (await t.admin`SELECT count(*)::int AS n FROM games`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });
});

describe("homePlan", () => {
  it("members see the owner's plan, outsiders see nothing", async () => {
    const { homePlan } = await import("../src/repo");
    expect(await asUser(t.db, u, (tx) => homePlan(tx, home))).toBe("pro");
    const stranger = await t.newUser("pro");
    expect(await asUser(t.db, stranger, (tx) => homePlan(tx, home))).toBeNull();
  });
});
