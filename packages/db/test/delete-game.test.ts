// The host's "delete this game" button used to die on the very first child delete: app
// roles hold no DELETE grant on most game tables, and the games_delete policy only
// covered drafts, so every attempt came back as FORBIDDEN. The cascade now lives in
// app.delete_game (SECURITY DEFINER, 0015); these tests pin down who may pull the
// trigger, what goes with the game (best-hand records included), and that the
// append-only guards still freeze everything outside a real deletion.
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordBestHand } from "../src/besthands";
import { asUser } from "../src/client";
import { addRuling, contributeToDraw, startDraw } from "../src/ideas";
import { ensureJoinInvite } from "../src/live";
import { DomainError, addPlayer, addToGame, closeGame, createGame, createHome, deleteGame, setCashOut } from "../src/repo";
import * as s from "../src/schema";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
let host: string; // owner of the home
let member: string; // member of the same home, not the owner
let outsider: string; // hosts a different home
let otherHome: string;
let homeId: string;
let pHost: string;
let pMember: string;

const hex = (v: string) => createHash("sha256").update(v).digest("hex");

/** A live game with everything that can point at a game attached to it. */
async function busyGame(): Promise<string> {
  const gameId = await asUser(t.db, host, async (tx) => {
    const g = await createGame(tx, host, homeId, 100);
    await addToGame(tx, host, g.id, pHost);
    await addToGame(tx, host, g.id, pMember, 50);
    await ensureJoinInvite(tx, host, g.id, (id) => Buffer.from(id, "utf8"));
    await addRuling(tx, host, g.id, {
      variant: "holdem",
      board: "Kh Kd 9c 9s 4d",
      hands: [
        { label: "Hadi", cards: "Qc 4h" },
        { label: "Abol", cards: "Ac 2h" },
      ],
    });
    const draw = await startDraw(tx, g.id);
    await contributeToDraw(tx, host, draw, hex("host randomness"));
    await recordBestHand(tx, host, { gameId: g.id, playerId: pHost, hand: "straight_flush", times: 2 });
    return g.id;
  });
  // Stories are written by the background role; stand in for it with the admin link.
  await t.admin`INSERT INTO game_stories(game_id, home_id, locale, body, model) VALUES (${gameId}, ${homeId}, 'fa', 'قصه‌ی شب', 'test')`;
  return gameId;
}

/** Row counts that should all be zero once the game is gone. */
async function remains(gameId: string) {
  const [r] = await t.admin`
    SELECT
      (SELECT count(*)::int FROM games          WHERE id = ${gameId})                                                AS games,
      (SELECT count(*)::int FROM game_entries   WHERE game_id = ${gameId})                                           AS entries,
      (SELECT count(*)::int FROM game_events    WHERE game_id = ${gameId})                                           AS events,
      (SELECT count(*)::int FROM invites        WHERE game_id = ${gameId})                                           AS invites,
      (SELECT count(*)::int FROM game_rulings   WHERE game_id = ${gameId})                                           AS rulings,
      (SELECT count(*)::int FROM game_draws     WHERE game_id = ${gameId})                                           AS draws,
      (SELECT count(*)::int FROM draw_contributions WHERE draw_id IN (SELECT id FROM game_draws WHERE game_id = ${gameId})) AS contributions,
      (SELECT count(*)::int FROM game_stories   WHERE game_id = ${gameId})                                           AS stories,
      (SELECT count(*)::int FROM best_hands     WHERE game_id = ${gameId})                                           AS best_hands`;
  return r as Record<string, number>;
}

beforeAll(async () => {
  t = await freshDb();
  host = await t.newUser("pro");
  member = await t.newUser("pro");
  outsider = await t.newUser("pro");
  await asUser(t.db, host, async (tx) => {
    homeId = (await createHome(tx, host, { name: "Casino Tel" })).id;
    pHost = (await addPlayer(tx, homeId, "Hadi")).id;
    pMember = (await addPlayer(tx, homeId, "Abol")).id;
  });
  await asUser(t.db, outsider, async (tx) => {
    otherHome = (await createHome(tx, outsider, { name: "Elsewhere" })).id;
  });
  await t.admin`UPDATE players SET user_id = ${host} WHERE id = ${pHost}`;
  await t.admin`INSERT INTO home_members(home_id, user_id, role, player_id) VALUES (${homeId}, ${member}, 'member', ${pMember})`;
  await t.admin`UPDATE players SET user_id = ${member} WHERE id = ${pMember}`;
});
afterAll(() => t.close());

describe("deleting a game", () => {
  it("removes a live game with everything that points at it", async () => {
    const g = await busyGame();
    const keep = await asUser(t.db, host, (tx) => createGame(tx, host, homeId, 100)); // another game stays
    const before = await remains(g);
    expect(Object.values(before).every((n) => n > 0)).toBe(true);

    const back = await asUser(t.db, host, (tx) => deleteGame(tx, host, g));
    expect(back).toBe(homeId);
    expect(await remains(g)).toEqual({
      games: 0, entries: 0, events: 0, invites: 0, rulings: 0, draws: 0, contributions: 0, stories: 0, best_hands: 0,
    });
    // The transaction-local hatch is closed again after the call.
    const [hatch] = await t.admin`SELECT coalesce(current_setting('app.deleting_game', true), '') AS v`;
    expect(hatch!.v).toBe("");
    // Other games of the home are untouched.
    const [kept] = await t.admin`SELECT count(*)::int AS n FROM games WHERE id = ${keep.id}`;
    expect(kept!.n).toBe(1);
  });

  it("a member of the home cannot: the action says FORBIDDEN, the database says not allowed", async () => {
    const g = await busyGame();
    const err = await asUser(t.db, member, (tx) => deleteGame(tx, member, g)).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("FORBIDDEN");
    // Even calling the definer function directly as the member changes nothing.
    expect(await pgError(asUser(t.db, member, (tx) => tx.execute(sql`SELECT app.delete_game(${g})`)))).toMatch(/not allowed/);
    expect((await remains(g)).games).toBe(1);
  });

  it("a host of another home cannot either", async () => {
    const g = await busyGame();
    expect(await pgError(asUser(t.db, outsider, (tx) => tx.execute(sql`SELECT app.delete_game(${g})`)))).toMatch(/not allowed/);
    expect((await remains(g)).games).toBe(1);
  });

  it("a closed game is frozen history and never goes", async () => {
    const g = await busyGame();
    await asUser(t.db, host, async (tx) => {
      await setCashOut(tx, host, g, pHost, 100);
      await setCashOut(tx, host, g, pMember, 50);
      const [row] = await tx.select({ v: s.games.version }).from(s.games).where(eq(s.games.id, g));
      await closeGame(tx, host, { gameId: g, closeKey: randomUUID(), expectedVersion: row!.v, carryDebts: false });
    });
    const err = await asUser(t.db, host, (tx) => deleteGame(tx, host, g)).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("FROZEN");
    expect(await pgError(asUser(t.db, host, (tx) => tx.execute(sql`SELECT app.delete_game(${g})`)))).toMatch(/closed and cannot be changed/);
    expect((await remains(g)).games).toBe(1);
  });

  it("a read-only home (lapsed plan) is refused", async () => {
    const g = await busyGame();
    await t.admin`UPDATE homes SET read_only = true WHERE id = ${homeId}`;
    try {
      const err = await asUser(t.db, host, (tx) => deleteGame(tx, host, g)).catch((e) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe("FORBIDDEN");
      expect(await pgError(asUser(t.db, host, (tx) => tx.execute(sql`SELECT app.delete_game(${g})`)))).toMatch(/not allowed/);
      expect((await remains(g)).games).toBe(1);
    } finally {
      await t.admin`UPDATE homes SET read_only = false WHERE id = ${homeId}`;
    }
  });

  it("an unknown game is NOT_FOUND; the database function on a missing id is a no-op", async () => {
    const missing = randomUUID();
    const err = await asUser(t.db, host, (tx) => deleteGame(tx, host, missing)).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("NOT_FOUND");
    await asUser(t.db, host, (tx) => tx.execute(sql`SELECT app.delete_game(${missing})`));
  });
});

describe("the append-only guards after 0015", () => {
  it("still freeze direct deletes — even with the hatch setting forced on", async () => {
    const g = await busyGame();
    // Direct delete by the host: RLS lets only draft games go, so nothing happens.
    await asUser(t.db, host, (tx) => tx.execute(sql`DELETE FROM games WHERE id = ${g}`));
    expect((await remains(g)).games).toBe(1);
    // Forcing the transaction-local setting on does not help either: app roles hold no
    // DELETE grant on the protected tables, so they cannot even reach the triggers.
    await expect(
      pgError(
        t.db.transaction(async (tx) => {
          await tx.execute("SET LOCAL ROLE app_user");
          await tx.execute(`SELECT set_config('app.user_id', '${host}', true)`);
          await tx.execute(`SELECT set_config('app.deleting_game', 'on', true)`);
          await tx.execute("DELETE FROM game_rulings");
        }),
      ),
    ).resolves.toMatch(/permission denied/);
    // And with no hatch at all, the guards raise as always (superuser, has grants).
    await expect(pgError(t.admin`DELETE FROM game_rulings WHERE game_id = ${g}`)).resolves.toMatch(/append-only/);
    await expect(pgError(t.admin`DELETE FROM game_draws WHERE game_id = ${g}`)).resolves.toMatch(/a draw cannot be changed/);
  });

  it("an ordinary edit of a draw is still refused", async () => {
    const g = await busyGame();
    await expect(pgError(t.admin`UPDATE game_draws SET players = players WHERE game_id = ${g}`)).resolves.toMatch(/a draw cannot be changed/);
  });
});
