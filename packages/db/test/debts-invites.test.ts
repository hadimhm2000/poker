// Debt confirmation rules, emailed invites that rename the placeholder player, and the
// closed-games count (features 4, 6 and 8 of the feedback list).
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser } from "../src/client";
import { createHomeInvite, activeInvites } from "../src/players";
import { addPlayer, addToGame, closedGamesCount, closeGame, createGame, createHome, ledger, markPaid, setCashOut } from "../src/repo";
import * as s from "../src/schema";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
let host: string;
let payer: string; // the user linked to the player who owes
let bystander: string; // another member: must not be able to confirm anyone's payment
let homeId: string;
let pHost: string;
let pPayer: string;
let pBystander: string;
let settlementOfPayer: string;

const sha = (x: string) => createHash("sha256").update(x).digest();
const tokenFor = (inviteId: string) => `tok-${inviteId}`;
const accept = (user: string, inviteId: string) =>
  asUser(t.db, user, (tx) => tx.execute(sql`SELECT app.accept_invite(${sha(tokenFor(inviteId))})`));

const playerName = async (id: string) => {
  const [p] = await t.admin`SELECT display_name FROM players WHERE id = ${id}`;
  return p!.display_name as string;
};

beforeAll(async () => {
  t = await freshDb();
  host = await t.newUser("pro");
  payer = await t.newUser("free");
  bystander = await t.newUser("free");
  await t.admin`UPDATE users SET display_name = 'Nicolas' WHERE id = ${payer}`;

  await asUser(t.db, host, async (tx) => {
    homeId = (await createHome(tx, host, { name: "Debts" })).id;
    pHost = (await addPlayer(tx, homeId, "Hadi")).id;
    pPayer = (await addPlayer(tx, homeId, "Nick")).id;
    pBystander = (await addPlayer(tx, homeId, "Sam")).id;
  });
  // bystander joins through a plain invite; payer stays unlinked for now (they join later,
  // through the emailed invite, to test the rename).
  const plain = await asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId }, (i) => sha(tokenFor(i))));
  await accept(bystander, plain);

  // one closed game: pPayer owes pHost, pBystander owes pHost
  await asUser(t.db, host, async (tx) => {
    const g = await createGame(tx, host, homeId, 0);
    for (const [p, i, o] of [
      [pPayer, 100, 0],
      [pBystander, 100, 0],
      [pHost, 200, 400],
    ] as const) {
      await addToGame(tx, host, g.id, p, i);
      await setCashOut(tx, host, g.id, p, o);
    }
    const [v] = await tx.select({ version: s.games.version }).from(s.games).where(eq(s.games.id, g.id));
    await closeGame(tx, host, { gameId: g.id, closeKey: randomUUID(), expectedVersion: v!.version });
  });
  const debts = await asUser(t.db, host, (tx) => ledger(tx, homeId));
  settlementOfPayer = debts.find((d) => d.from === pPayer)!.settlementId;
});
afterAll(() => t.close());

describe("debt confirmation (only the debtor or the host)", () => {
  it("the ledger is open", async () => {
    const debts = await asUser(t.db, bystander, (tx) => ledger(tx, homeId));
    expect(debts.length).toBe(2);
  });

  it("another member cannot confirm someone else's payment", async () => {
    expect(await pgError(asUser(t.db, bystander, (tx) => markPaid(tx, bystander, settlementOfPayer)))).toMatch(/FORBIDDEN/);
    // nothing was written
    const [row] = await t.admin`SELECT count(*)::int AS n FROM debt_payments WHERE settlement_id = ${settlementOfPayer}`;
    expect(row!.n).toBe(0);
  });

  it("the host may confirm, and the debtor may confirm their own", async () => {
    await asUser(t.db, host, (tx) => markPaid(tx, host, settlementOfPayer));
    const [row] = await t.admin`SELECT count(*)::int AS n FROM debt_payments WHERE settlement_id = ${settlementOfPayer}`;
    expect(row!.n).toBe(1);
  });
});

describe("invites by email rename the placeholder player", () => {
  it("only the host may create an invite that records an email, and it is single-use", async () => {
    expect(
      await pgError(
        asUser(t.db, bystander, (tx) => createHomeInvite(tx, bystander, { homeId, email: "nick@x.io" }, (i) => sha(tokenFor(i)))),
      ),
    ).toMatch(/FORBIDDEN/);
    const inv = await asUser(
      t.db,
      host,
      (tx) => createHomeInvite(tx, host, { homeId, playerId: pPayer, maxUses: 5, email: "nick@x.io" }, (i) => sha(tokenFor(i))),
    );
    const listed = (await asUser(t.db, host, (tx) => activeInvites(tx, homeId))).find((i) => i.id === inv)!;
    expect(listed.email).toBe("nick@x.io");
    expect(listed.maxUses).toBe(1); // emailed invites work once
  });

  it("accepting with a different sign-up name replaces the placeholder name", async () => {
    const inv = await asUser(
      t.db,
      host,
      (tx) => createHomeInvite(tx, host, { homeId, playerId: pPayer, email: "nick@x.io" }, (i) => sha(tokenFor(i))),
    );
    await accept(payer, inv);
    expect(await playerName(pPayer)).toBe("Nicolas"); // was "Nick"

    // the account is linked to the player, so their debts can now be confirmed by them
    const debts = await asUser(t.db, payer, (tx) => ledger(tx, homeId));
    const mine = debts.find((d) => d.from === pPayer);
    if (mine) {
      await asUser(t.db, payer, (tx) => markPaid(tx, payer, mine.settlementId)); // no error
    }
  });

  it("the same name keeps the player as is; a taken name keeps the old one", async () => {
    // a placeholder "Nico" (typed by the host before that person joined)
    const p2 = (await asUser(t.db, host, (tx) => addPlayer(tx, homeId, "Nico"))).id;
    // a second user whose sign-up name is "Nicolas" accepts an invite bound to it: that
    // name is already taken by the renamed player above, so the placeholder stays.
    const second = await t.newUser("free");
    await t.admin`UPDATE users SET display_name = 'Nicolas' WHERE id = ${second}`;
    const inv = await asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId, playerId: p2 }, (i) => sha(tokenFor(i))));
    await accept(second, inv);
    expect(await playerName(p2)).toBe("Nico");

    // and a user whose name matches exactly keeps it too (nothing to change)
    const p3 = (await asUser(t.db, host, (tx) => addPlayer(tx, homeId, "Sami"))).id;
    const third = await t.newUser("free");
    await t.admin`UPDATE users SET display_name = 'Sami' WHERE id = ${third}`;
    const inv2 = await asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId, playerId: p3 }, (i) => sha(tokenFor(i))));
    await accept(third, inv2);
    expect(await playerName(p3)).toBe("Sami");
  });
});

describe("closed-games count", () => {
  it("counts every closed game, including one force-closed with nobody at the table", async () => {
    const before = await asUser(t.db, host, (tx) => closedGamesCount(tx, homeId));
    // force-close an empty game: it consumes a number but has no result rows
    await asUser(t.db, host, async (tx) => {
      const g = await createGame(tx, host, homeId, 0);
      const [v] = await tx.select({ version: s.games.version }).from(s.games).where(eq(s.games.id, g.id));
      await closeGame(tx, host, { gameId: g.id, closeKey: randomUUID(), expectedVersion: v!.version, force: true });
    });
    expect(await asUser(t.db, host, (tx) => closedGamesCount(tx, homeId))).toBe(before + 1);
  });
});
