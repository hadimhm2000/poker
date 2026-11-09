// Best hand (0014): the host records royal flush / straight flush / four of a kind per
// game; members only read. Records survive a merge and are not blocked by a closed game.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser } from "../src/client";
import { mergePlayers } from "../src/players";
import { addPlayer, addToGame, closeGame, createGame, createHome, setCashOut } from "../src/repo";
import { bestHandTotals, deleteBestHand, gameBestHands, homeBestHands, recordBestHand } from "../src/besthands";
import * as s from "../src/schema";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
let host: string;
let member: string; // a joined member of the host's home (not the host)
let outsider: string; // a user of another home
let homeId: string;
let otherHomeId: string;
let liveGame: string; // still open
let closedGame: string; // closed and frozen
let pAli: string;
let pMina: string;
let pReza: string;
let pOther: string; // player of the OTHER home

beforeAll(async () => {
  t = await freshDb();
  host = await t.newUser();
  member = await t.newUser();
  outsider = await t.newUser();
  await asUser(t.db, host, async (tx) => {
    const home = await createHome(tx, host, { name: "Friday", currency: "EUR" });
    homeId = home.id;
    pAli = (await addPlayer(tx, home.id, "Ali")).id;
    pMina = (await addPlayer(tx, home.id, "Mina")).id;
    pReza = (await addPlayer(tx, home.id, "Reza")).id;
    // One open game and one closed game.
    liveGame = (await createGame(tx, host, home.id, 100)).id;
    await addToGame(tx, host, liveGame, pAli);
    await addToGame(tx, host, liveGame, pMina);
    const g2 = await createGame(tx, host, home.id, 100);
    closedGame = g2.id;
    await addToGame(tx, host, closedGame, pAli);
    await addToGame(tx, host, closedGame, pMina);
    await setCashOut(tx, host, closedGame, pAli, 150);
    await setCashOut(tx, host, closedGame, pMina, 50);
    const [cur] = await tx.select().from(s.games).where(eq(s.games.id, closedGame));
    await closeGame(tx, host, { gameId: closedGame, closeKey: randomUUID(), expectedVersion: cur!.version });
  });
  // A member of the host's home (linked to player Mina, like a joined account).
  await t.admin`UPDATE players SET user_id = ${member} WHERE id = ${pMina}`;
  await t.admin`INSERT INTO home_members(home_id, user_id, role, player_id) VALUES (${homeId}, ${member}, 'member', ${pMina})`;
  // A different home with its own player.
  await asUser(t.db, outsider, async (tx) => {
    const other = await createHome(tx, outsider, { name: "Other" });
    otherHomeId = other.id;
    pOther = (await addPlayer(tx, other.id, "Sara")).id;
  });
});

afterAll(() => t.close());

describe("the host records best hands", () => {
  it("records on a live game and reads it back", async () => {
    await asUser(t.db, host, (tx) =>
      recordBestHand(tx, host, { gameId: liveGame, playerId: pAli, hand: "royal_flush", times: 1 }),
    );
    const rows = await asUser(t.db, host, (tx) => gameBestHands(tx, liveGame));
    expect(rows).toEqual([{ id: rows[0]!.id, playerId: pAli, name: "Ali", hand: "royal_flush", times: 1 }]);
  });

  it("records several times and other hands", async () => {
    await asUser(t.db, host, (tx) =>
      recordBestHand(tx, host, { gameId: liveGame, playerId: pMina, hand: "straight_flush", times: 2 }),
    );
    await asUser(t.db, host, (tx) =>
      recordBestHand(tx, host, { gameId: liveGame, playerId: pAli, hand: "four_of_a_kind", times: 3 }),
    );
    const rows = await asUser(t.db, host, (tx) => gameBestHands(tx, liveGame));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => `${r.name}:${r.hand}:${r.times}`).sort()).toEqual([
      "Ali:four_of_a_kind:3",
      "Ali:royal_flush:1",
      "Mina:straight_flush:2",
    ]);
  });

  it("records again to correct the count (upsert, not a second row)", async () => {
    await asUser(t.db, host, (tx) =>
      recordBestHand(tx, host, { gameId: liveGame, playerId: pMina, hand: "straight_flush", times: 5 }),
    );
    const rows = await asUser(t.db, host, (tx) => gameBestHands(tx, liveGame));
    const mina = rows.filter((r) => r.name === "Mina");
    expect(mina).toEqual([{ id: mina[0]!.id, playerId: pMina, name: "Mina", hand: "straight_flush", times: 5 }]);
    expect(rows).toHaveLength(3);
  });

  it("records on a closed game too (the record is not part of the frozen result)", async () => {
    await asUser(t.db, host, (tx) =>
      recordBestHand(tx, host, { gameId: closedGame, playerId: pReza, hand: "four_of_a_kind", times: 1 }),
    );
    const rows = await asUser(t.db, host, (tx) => gameBestHands(tx, closedGame));
    expect(rows).toEqual([{ id: rows[0]!.id, playerId: pReza, name: "Reza", hand: "four_of_a_kind", times: 1 }]);
  });

  it("refuses a player from another home", async () => {
    await expect(
      asUser(t.db, host, (tx) => recordBestHand(tx, host, { gameId: liveGame, playerId: pOther, hand: "royal_flush", times: 1 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses invalid input (times out of range, unknown hand)", async () => {
    await expect(
      asUser(t.db, host, (tx) => recordBestHand(tx, host, { gameId: liveGame, playerId: pAli, hand: "royal_flush", times: 100 })),
    ).rejects.toThrow();
    await expect(
      asUser(t.db, host, (tx) => recordBestHand(tx, host, { gameId: liveGame, playerId: pAli, hand: "full_house" as never, times: 1 })),
    ).rejects.toThrow();
  });
});

describe("nobody else may record", () => {
  it("a member gets FORBIDDEN before touching the table", async () => {
    await expect(
      asUser(t.db, member, (tx) => recordBestHand(tx, member, { gameId: liveGame, playerId: pMina, hand: "royal_flush", times: 1 })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an outsider cannot even insert directly (RLS)", async () => {
    const err = await pgError(
      asUser(t.db, outsider, (tx) =>
        tx.insert(s.bestHands).values({ gameId: liveGame, homeId, playerId: pAli, hand: "royal_flush", recordedBy: outsider }),
      ),
    );
    expect(err).toMatch(/row-level security|not allowed/i);
  });

  it("a member cannot delete the host's record (FORBIDDEN), the host can", async () => {
    const [row] = await t.admin`SELECT id FROM best_hands WHERE game_id = ${closedGame} AND player_id = ${pReza}`;
    await expect(asUser(t.db, member, (tx) => deleteBestHand(tx, member, row!.id as string))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await asUser(t.db, host, (tx) => deleteBestHand(tx, host, row!.id as string));
    expect(await asUser(t.db, host, (tx) => gameBestHands(tx, closedGame))).toEqual([]);
  });
});

describe("reads and totals", () => {
  it("members see the records, outsiders see nothing", async () => {
    const mine = await asUser(t.db, member, (tx) => homeBestHands(tx, homeId));
    expect(mine.length).toBe(3);
    const theirs = await asUser(t.db, outsider, (tx) => homeBestHands(tx, homeId));
    expect(theirs).toEqual([]);
  });

  it("homeBestHands carries the game number and the play date", async () => {
    // A record on the closed game (Reza's was removed in the previous describe).
    await asUser(t.db, host, (tx) =>
      recordBestHand(tx, host, { gameId: closedGame, playerId: pMina, hand: "royal_flush", times: 1 }),
    );
    const rows = await asUser(t.db, host, (tx) => homeBestHands(tx, homeId));
    expect(rows).toHaveLength(4);
    const closed = rows.filter((r) => r.gameId === closedGame);
    const live = rows.filter((r) => r.gameId === liveGame);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.number).toBe(1);
    expect(closed[0]!.at).toBeInstanceOf(Date);
    expect(live).toHaveLength(3);
    expect(live.every((r) => r.number === null)).toBe(true);
    expect(live.every((r) => r.at instanceof Date)).toBe(true);
  });

  it("counts records of a merged duplicate under the kept player", async () => {
    // Duplicate of Ali records first, then the host merges it into Ali.
    await asUser(t.db, host, async (tx) => {
      const dup = await addPlayer(tx, homeId, "Ali (old)");
      await recordBestHand(tx, host, { gameId: liveGame, playerId: dup.id, hand: "straight_flush", times: 2 });
      await mergePlayers(tx, pAli, dup.id);
    });
    const rows = await asUser(t.db, host, (tx) => homeBestHands(tx, homeId));
    expect(rows).toHaveLength(5);
    const ali = rows.filter((r) => r.playerId === pAli);
    expect(ali).toHaveLength(3); // royal flush + four of a kind + the duplicate's straight flush
    const totals = bestHandTotals(rows);
    const aliTotals = totals.players.find((p) => p.playerId === pAli)!;
    expect(aliTotals.counts).toEqual({ royal_flush: 1, straight_flush: 2, four_of_a_kind: 3 });
    expect(aliTotals.total).toBe(6);
    // Ali: 1 royal + 3 four of a kind + 2 straight (via the merge); Mina: 5 straight + 1 royal.
    expect(totals.byHand).toEqual({ royal_flush: 2, straight_flush: 7, four_of_a_kind: 3 });
    expect(totals.total).toBe(12);
  });

  it("bestHandTotals sorts players by total, biggest first", () => {
    const totals = bestHandTotals([
      { playerId: "a", name: "A", hand: "royal_flush", times: 1 },
      { playerId: "b", name: "B", hand: "four_of_a_kind", times: 4 },
      { playerId: "b", name: "B", hand: "royal_flush", times: 1 },
      { playerId: "c", name: "C", hand: "straight_flush", times: 1 },
      { playerId: "c", name: "C", hand: "nonsense", times: 99 }, // ignored, not one of the three
    ]);
    expect(totals.players.map((p) => p.playerId)).toEqual(["b", "a", "c"]);
    expect(totals.players[0]).toMatchObject({ total: 5 });
    expect(totals.total).toBe(7);
  });
});
