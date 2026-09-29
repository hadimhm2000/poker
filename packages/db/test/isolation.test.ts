// Phase 0 exit gate: user A cannot reach user B's data with any request.
import { createHash, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser } from "../src/client.js";
import {
  addPlayer,
  addToGame,
  closeGame,
  createGame,
  createHome,
  history,
  ledger,
  markPaid,
  setCashOut,
} from "../src/repo.js";
import * as s from "../src/schema.js";
import { type TestDb, freshDb, pgError } from "./helpers.js";

let t: TestDb;
let alice: string;
let bob: string;
let mina: string; // member of Alice's home
let aliceHome: string;
let aliceGame: string;
let openGameId: string;
let pAli: string;
let pMina: string;
let pReza: string;

beforeAll(async () => {
  t = await freshDb();
  alice = await t.newUser();
  bob = await t.newUser();
  mina = await t.newUser();
  await asUser(t.db, alice, async (tx) => {
    const home = await createHome(tx, alice, { name: "Friday", currency: "EUR" });
    aliceHome = home.id;
    pAli = (await addPlayer(tx, home.id, "Ali")).id;
    pMina = (await addPlayer(tx, home.id, "Mina")).id;
    pReza = (await addPlayer(tx, home.id, "Reza")).id;
    const g = await createGame(tx, alice, home.id, 100);
    aliceGame = g.id;
    await addToGame(tx, alice, g.id, pAli);
    await addToGame(tx, alice, g.id, pMina);
    await setCashOut(tx, alice, g.id, pAli, 150);
    await setCashOut(tx, alice, g.id, pMina, 50);
    const [cur] = await tx.select().from(s.games).where(eq(s.games.id, g.id));
    await closeGame(tx, alice, { gameId: g.id, closeKey: randomUUID(), expectedVersion: cur!.version });
    const open = await createGame(tx, alice, home.id, 100);
    openGameId = open.id;
    await addToGame(tx, alice, open.id, pAli);
    await addToGame(tx, alice, open.id, pMina);
  });
  // Mina joins through an invite linked to her player.
  const token = randomBytes(32);
  const tokenHash = createHash("sha256").update(token).digest();
  await asUser(t.db, alice, (tx) =>
    tx.insert(s.invites).values({ homeId: aliceHome, tokenHash, playerId: pMina, expiresAt: new Date(Date.now() + 3600e3), createdBy: alice }),
  );
  await asUser(t.db, mina, (tx) => tx.execute(sql`SELECT app.accept_invite(${tokenHash})`));
});

afterAll(() => t.close());

describe("an outsider (Bob) sees nothing of Alice's home", () => {
  const tables = [s.homes, s.homeMembers, s.players, s.games, s.gameEntries, s.gameEvents, s.settlements, s.debtPayments, s.invites] as const;

  it("every table reads empty", async () => {
    await asUser(t.db, bob, async (tx) => {
      for (const table of tables) expect(await tx.select().from(table)).toEqual([]);
      expect(await history(tx, {})).toEqual([]);
      expect(await ledger(tx, aliceHome)).toEqual([]);
    });
  });

  it("sees only his own user row and no sessions or audit log", async () => {
    await asUser(t.db, bob, async (tx) => {
      const rows = await tx.select({ id: s.users.id }).from(s.users);
      expect(rows).toEqual([{ id: bob }]);
      expect(await tx.select().from(s.sessions)).toEqual([]);
    });
    expect(await pgError(asUser(t.db, bob, (tx) => tx.select().from(s.auditLog)))).toMatch(/permission denied/);
  });

  it("updates and deletes touch zero rows", async () => {
    await asUser(t.db, bob, async (tx) => {
      expect(await tx.update(s.homes).set({ name: "pwned" }).where(eq(s.homes.id, aliceHome)).returning()).toEqual([]);
      expect(await tx.update(s.players).set({ displayName: "x" }).where(eq(s.players.homeId, aliceHome)).returning()).toEqual([]);
      expect(await tx.update(s.gameEntries).set({ cashOut: 0 }).where(eq(s.gameEntries.gameId, openGameId)).returning()).toEqual([]);
      expect(await tx.delete(s.games).where(eq(s.games.id, openGameId)).returning()).toEqual([]);
      expect(await tx.delete(s.homeMembers).where(eq(s.homeMembers.homeId, aliceHome)).returning()).toEqual([]);
    });
  });

  it("cannot insert into Alice's home", async () => {
    expect(await pgError(asUser(t.db, bob, (tx) => addPlayer(tx, aliceHome, "Spy")))).toMatch(/row-level security/);
    expect(await pgError(asUser(t.db, bob, (tx) => createGame(tx, bob, aliceHome)))).toMatch(/row-level security/);
    expect(
      await pgError(asUser(t.db, bob, (tx) => tx.insert(s.homeMembers).values({ homeId: aliceHome, userId: bob, role: "owner" }))),
    ).toMatch(/permission denied|row-level security/);
    expect(
      await pgError(asUser(t.db, bob, (tx) => tx.insert(s.homes).values({ ownerId: alice, name: "fake" }))),
    ).toMatch(/row-level security/);
  });

  it("cannot join with a made-up invite or mark debts paid", async () => {
    expect(await pgError(asUser(t.db, bob, (tx) => tx.execute(sql`SELECT app.accept_invite(${randomBytes(32)})`)))).toMatch(/invite is not valid/);
    const [st] = await t.admin`SELECT id FROM settlements LIMIT 1`;
    expect(await pgError(asUser(t.db, bob, (tx) => markPaid(tx, bob, st!.id)))).toMatch(/row-level security/);
  });

  it("cannot act without a signed-in user", async () => {
    const err = await pgError(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.insert(s.homes).values({ ownerId: alice, name: "anon" });
      }),
    );
    expect(err).toMatch(/not signed in|row-level security/);
  });
});

describe("a member (Mina) can read but not change", () => {
  it("sees the home, its players and history", async () => {
    await asUser(t.db, mina, async (tx) => {
      expect((await tx.select().from(s.homes)).map((h) => h.id)).toEqual([aliceHome]);
      expect((await tx.select().from(s.players)).length).toBe(3);
      expect((await history(tx, {})).length).toBe(2);
    });
  });

  it("her invite linked her to her player", async () => {
    const [p] = await t.admin`SELECT user_id FROM players WHERE id = ${pMina}`;
    expect(p!.user_id).toBe(mina);
  });

  it("cannot enter numbers, add players, create games or remove members", async () => {
    await asUser(t.db, mina, async (tx) => {
      expect(await tx.update(s.gameEntries).set({ cashOut: 999 }).where(eq(s.gameEntries.gameId, openGameId)).returning()).toEqual([]);
      expect(await tx.delete(s.homeMembers).returning()).toEqual([]);
    });
    expect(await pgError(asUser(t.db, mina, (tx) => addPlayer(tx, aliceHome, "X")))).toMatch(/row-level security/);
    expect(await pgError(asUser(t.db, mina, (tx) => createGame(tx, mina, aliceHome)))).toMatch(/row-level security/);
  });

  it("can request a rebuy for herself only", async () => {
    await asUser(t.db, mina, (tx) =>
      tx.insert(s.gameEvents).values({ gameId: openGameId, type: "request", playerId: pMina, amount: 100, actorId: mina }),
    );
    expect(
      await pgError(
        asUser(t.db, mina, (tx) =>
          tx.insert(s.gameEvents).values({ gameId: openGameId, type: "request", playerId: pAli, amount: 100, actorId: mina }),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await pgError(
        asUser(t.db, mina, (tx) =>
          tx.insert(s.gameEvents).values({ gameId: openGameId, type: "rebuy", playerId: pMina, amount: 100, actorId: mina }),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it("only the creditor of a debt (or the host) can mark it paid", async () => {
    // Mina lost 50 to Ali; Ali has no account, so only Alice (host) may mark it.
    const [st] = await t.admin`SELECT id FROM settlements WHERE from_player = ${pMina}`;
    expect(await pgError(asUser(t.db, mina, (tx) => markPaid(tx, mina, st!.id)))).toMatch(/row-level security/);
    await asUser(t.db, alice, (tx) => markPaid(tx, alice, st!.id));
    await asUser(t.db, alice, async (tx) => expect(await ledger(tx, aliceHome)).toEqual([]));
  });

  it("confirms only her own result", async () => {
    await asUser(t.db, mina, (tx) => tx.execute(sql`SELECT app.confirm_result(${openGameId})`));
    const rows = await t.admin`SELECT player_id, confirmed_at FROM game_entries WHERE game_id = ${openGameId} ORDER BY player_id`;
    const confirmed = rows.filter((r) => r.confirmed_at).map((r) => r.player_id);
    expect(confirmed).toEqual([pMina]);
    expect(pReza).toBeTruthy();
  });
});
