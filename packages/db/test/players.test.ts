// Home and player modules: member list and removal, home invites, avatars, payment details
// and merging duplicate players (open games only; frozen games are read through a mapping).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homeStats } from "@poker/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser } from "../src/client";
import { ensureJoinInvite, requestRebuy } from "../src/live";
import {
  AVATARS,
  activeInvites,
  createHomeInvite,
  memberList,
  mergePlayers,
  removeMember,
  revokeInvite,
  setAvatar,
  setPaymentInfo,
} from "../src/players";
import { addPlayer, addToGame, closeGame, createGame, createHome, history, ledger, resultRows, setCashOut } from "../src/repo";
import * as s from "../src/schema";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
let host: string;
let friend: string;
let other: string;
let stranger: string;
let homeId: string;
let pHost: string;
let pFriend: string;

const sha = (x: string) => createHash("sha256").update(x).digest();
const tokenFor = (inviteId: string) => `tok-${inviteId}`;
const accept = (user: string, inviteId: string) =>
  asUser(t.db, user, (tx) => tx.execute(sql`SELECT app.accept_invite(${sha(tokenFor(inviteId))})`));

/** A closed game with the given [player, in, out] rows. */
async function closedGame(rows: [string, number, number][]) {
  return asUser(t.db, host, async (tx) => {
    const g = await createGame(tx, host, homeId, 0);
    for (const [p, totalIn, out] of rows) {
      await addToGame(tx, host, g.id, p, totalIn);
      await setCashOut(tx, host, g.id, p, out);
    }
    const [v] = await tx.select({ version: s.games.version }).from(s.games).where(eq(s.games.id, g.id));
    await closeGame(tx, host, { gameId: g.id, closeKey: randomUUID(), expectedVersion: v!.version });
    return g.id;
  });
}

beforeAll(async () => {
  t = await freshDb();
  host = await t.newUser("pro");
  friend = await t.newUser("free");
  other = await t.newUser("free");
  stranger = await t.newUser("free");
  await t.admin`UPDATE users SET display_name = 'Hadi' WHERE id = ${host}`;
  await asUser(t.db, host, async (tx) => {
    homeId = (await createHome(tx, host, { name: "Friday" })).id;
    pHost = (await addPlayer(tx, homeId, "Hadi")).id;
    pFriend = (await addPlayer(tx, homeId, "Abol")).id;
  });
  // friend joins linked to "Abol"; other joins with a plain link.
  const i1 = await asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId, playerId: pFriend }, (i) => sha(tokenFor(i))));
  await accept(friend, i1);
  const i2 = await asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId }, (i) => sha(tokenFor(i))));
  await accept(other, i2);
});
afterAll(() => t.close());

describe("members", () => {
  it("members see who is in the home, with names but no emails", async () => {
    const list = await asUser(t.db, friend, (tx) => memberList(tx, homeId));
    expect(list.map((m) => [m.role, m.name])).toEqual([
      ["owner", "Hadi"],
      ["member", "Abol"],
      ["member", ""],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/@test\.local/);
    expect(list[1]!.playerId).toBe(pFriend);
  });

  it("a stranger sees nobody", async () => {
    expect(await asUser(t.db, stranger, (tx) => memberList(tx, homeId))).toEqual([]);
  });

  it("a member cannot remove anyone, and the host cannot remove themselves", async () => {
    expect(await pgError(asUser(t.db, friend, (tx) => removeMember(tx, homeId, other)))).toMatch(/NOT_FOUND/);
    expect(await pgError(asUser(t.db, friend, (tx) => removeMember(tx, homeId, host)))).toMatch(/NOT_FOUND/);
    expect(await pgError(asUser(t.db, host, (tx) => removeMember(tx, homeId, host)))).toMatch(/NOT_FOUND/);
    // Even a direct delete of the owner row is filtered out by RLS.
    await asUser(t.db, host, (tx) => tx.delete(s.homeMembers).where(eq(s.homeMembers.userId, host)));
    const [m] = await t.admin`SELECT role FROM home_members WHERE home_id = ${homeId} AND user_id = ${host}`;
    expect(m!.role).toBe("owner");
  });

  it("a removed member loses access at once", async () => {
    const g = await asUser(t.db, host, async (tx) => {
      const g = await createGame(tx, host, homeId, 100);
      await addToGame(tx, host, g.id, pFriend);
      return g.id;
    });
    // Before: friend sees the home and may ask for a rebuy.
    expect(await asUser(t.db, friend, (tx) => tx.select().from(s.homes))).toHaveLength(1);

    await asUser(t.db, host, (tx) => removeMember(tx, homeId, friend));

    await asUser(t.db, friend, async (tx) => {
      expect(await tx.select().from(s.homes)).toEqual([]);
      expect(await tx.select().from(s.players)).toEqual([]);
      expect(await tx.select().from(s.games)).toEqual([]);
      expect(await tx.select().from(s.gameEntries)).toEqual([]);
      expect(await memberList(tx, homeId)).toEqual([]);
    });
    expect(await pgError(asUser(t.db, friend, (tx) => requestRebuy(tx, friend, g)))).toMatch(/NOT_IN_GAME|row-level security/);
    expect(await pgError(asUser(t.db, friend, (tx) => setAvatar(tx, pFriend, "🦊")))).toMatch(/not allowed/);
    const [audit] = await t.admin`SELECT count(*)::int AS n FROM audit_log WHERE target_table = 'home_members' AND action = 'delete'`;
    expect(audit!.n).toBe(1);

    // Back in with a new link from the host: the player link is kept.
    const inv = await asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId }, (i) => sha(tokenFor(i))));
    await accept(friend, inv);
    expect(await asUser(t.db, friend, (tx) => tx.select().from(s.homes))).toHaveLength(1);
  });
});

describe("home invites", () => {
  it("the host lists active links with expiry and uses; members and strangers see none", async () => {
    const inv = await asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId, maxUses: 3, days: 2 }, (i) => sha(tokenFor(i))));
    const list = await asUser(t.db, host, (tx) => activeInvites(tx, homeId));
    const row = list.find((i) => i.id === inv)!;
    expect(row.maxUses).toBe(3);
    expect(row.uses).toBe(0);
    expect(row.tokenHash.equals(sha(tokenFor(inv)))).toBe(true);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(864e5);
    // Used-up and game links are not listed.
    expect(list.every((i) => i.uses < i.maxUses)).toBe(true);
    expect(await asUser(t.db, friend, (tx) => activeInvites(tx, homeId))).toEqual([]);
    expect(await asUser(t.db, stranger, (tx) => activeInvites(tx, homeId))).toEqual([]);
  });

  it("game join links are not home invites", async () => {
    const g = await asUser(t.db, host, (tx) => createGame(tx, host, homeId, 10));
    const j = await asUser(t.db, host, (tx) => ensureJoinInvite(tx, host, g.id, (i) => sha(tokenFor(i))));
    const list = await asUser(t.db, host, (tx) => activeInvites(tx, homeId));
    expect(list.some((i) => i.id === j)).toBe(false);
  });

  it("a revoked link stops working; only the host may revoke", async () => {
    const inv = await asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId, maxUses: 5 }, (i) => sha(tokenFor(i))));
    expect(await pgError(asUser(t.db, friend, (tx) => revokeInvite(tx, homeId, inv)))).toMatch(/NOT_FOUND/);
    await asUser(t.db, host, (tx) => revokeInvite(tx, homeId, inv));
    expect((await asUser(t.db, host, (tx) => activeInvites(tx, homeId))).some((i) => i.id === inv)).toBe(false);
    expect(await pgError(accept(stranger, inv))).toMatch(/invite is not valid/);
    expect(await pgError(asUser(t.db, host, (tx) => revokeInvite(tx, homeId, inv)))).toMatch(/NOT_FOUND/);
  });

  it("a member cannot create links, and a link cannot target a linked player", async () => {
    expect(await pgError(asUser(t.db, friend, (tx) => createHomeInvite(tx, friend, { homeId }, (i) => sha(tokenFor(i)))))).toMatch(
      /row-level security/,
    );
    expect(
      await pgError(asUser(t.db, host, (tx) => createHomeInvite(tx, host, { homeId, playerId: pFriend }, (i) => sha(tokenFor(i))))),
    ).toMatch(/INVALID/);
  });
});

describe("avatars", () => {
  it("the player's own user and the host may set it; other members may not", async () => {
    await asUser(t.db, friend, (tx) => setAvatar(tx, pFriend, "🦊"));
    await asUser(t.db, host, (tx) => setAvatar(tx, pHost, "👑"));
    expect(await pgError(asUser(t.db, other, (tx) => setAvatar(tx, pFriend, "🐸")))).toMatch(/not allowed/);
    expect(await pgError(asUser(t.db, stranger, (tx) => setAvatar(tx, pHost, "🐸")))).toMatch(/not allowed/);
    const rows = await t.admin`SELECT id, avatar FROM players WHERE id IN (${pFriend}, ${pHost})`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.avatar]))).toEqual({ [pFriend]: "🦊", [pHost]: "👑" });
  });

  it("only the allowed list is accepted, by the app and by the database", async () => {
    expect(await pgError(asUser(t.db, host, (tx) => setAvatar(tx, pHost, "<script>")))).toMatch(/Invalid/);
    // The host may update players directly; the CHECK constraint still refuses.
    expect(
      await pgError(asUser(t.db, host, (tx) => tx.update(s.players).set({ avatar: "💩" }).where(eq(s.players.id, pHost)))),
    ).toMatch(/players_avatar_check/);
    // Every avatar the app offers is accepted by the database (the two lists match).
    await asUser(t.db, host, async (tx) => {
      for (const a of AVATARS) await setAvatar(tx, pHost, a);
      await setAvatar(tx, pHost, null);
    });
  });
});

describe("payment details", () => {
  const blob = randomBytes(64);

  it("the player's own user and the host may set them; members read them; others cannot", async () => {
    await asUser(t.db, friend, (tx) => setPaymentInfo(tx, pFriend, blob));
    expect(await pgError(asUser(t.db, other, (tx) => setPaymentInfo(tx, pFriend, randomBytes(8))))).toMatch(/not allowed/);
    expect(await pgError(asUser(t.db, stranger, (tx) => setPaymentInfo(tx, pFriend, randomBytes(8))))).toMatch(/not allowed/);
    const [seen] = await asUser(t.db, other, (tx) =>
      tx.select({ enc: s.players.paymentInfoEnc }).from(s.players).where(eq(s.players.id, pFriend)),
    );
    expect(Buffer.from(seen!.enc!).equals(blob)).toBe(true);
    expect(await asUser(t.db, stranger, (tx) => tx.select().from(s.players).where(eq(s.players.id, pFriend)))).toEqual([]);
    await asUser(t.db, host, (tx) => setPaymentInfo(tx, pHost, randomBytes(32)));
  });

  it("never reach the audit log", async () => {
    const rows = await t.admin`SELECT details::text AS d FROM audit_log WHERE target_table = 'players'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.d).not.toMatch(/payment_info_enc/);
      expect(r.d).not.toContain(blob.toString("hex"));
    }
  });
});

describe("merging duplicates", () => {
  let keep: string;
  let dup: string;
  let gClosedDup: string;
  let gClosedBoth: string;
  let gOpenDup: string;
  let gOpenBoth: string;
  let frozenHash: string;

  beforeAll(async () => {
    await asUser(t.db, host, async (tx) => {
      keep = (await addPlayer(tx, homeId, "Ali")).id;
      dup = (await addPlayer(tx, homeId, "Aly")).id;
    });
    gClosedDup = await closedGame([
      [dup, 100, 300],
      [pHost, 200, 0],
    ]);
    gClosedBoth = await closedGame([
      [keep, 100, 150],
      [dup, 100, 0],
      [pHost, 100, 150],
    ]);
    await asUser(t.db, host, async (tx) => {
      gOpenDup = (await createGame(tx, host, homeId, 50)).id;
      await addToGame(tx, host, gOpenDup, dup);
      await addToGame(tx, host, gOpenDup, pHost);
      gOpenBoth = (await createGame(tx, host, homeId, 50)).id;
      await addToGame(tx, host, gOpenBoth, dup);
      await addToGame(tx, host, gOpenBoth, keep);
    });
    const [g] = await t.admin`SELECT hash FROM games WHERE id = ${gClosedDup}`;
    frozenHash = g!.hash;
  });

  it("only the host may merge, within one home", async () => {
    expect(await pgError(asUser(t.db, friend, (tx) => mergePlayers(tx, keep, dup)))).toMatch(/not allowed/);
    const otherHome = await asUser(t.db, stranger, async (tx) => {
      const h = await createHome(tx, stranger, { name: "Other" });
      return (await addPlayer(tx, h.id, "Ali")).id;
    });
    expect(await pgError(asUser(t.db, host, (tx) => mergePlayers(tx, keep, otherHome)))).toMatch(/not allowed/);
    expect(await pgError(asUser(t.db, host, (tx) => mergePlayers(tx, keep, keep)))).toMatch(/INVALID/);
  });

  it("is refused while both sit in the same open game", async () => {
    expect(await pgError(asUser(t.db, host, (tx) => mergePlayers(tx, keep, dup)))).toMatch(/same open game/);
    const [p] = await t.admin`SELECT merged_into FROM players WHERE id = ${dup}`;
    expect(p!.merged_into).toBeNull();
  });

  it("is refused when both players have accounts", async () => {
    const a = await t.newUser("free");
    await t.admin`UPDATE players SET user_id = ${a} WHERE id = ${keep}`;
    await t.admin`UPDATE players SET user_id = ${stranger} WHERE id = ${dup}`;
    expect(await pgError(asUser(t.db, host, (tx) => mergePlayers(tx, keep, dup)))).toMatch(/linked to accounts/);
    await t.admin`UPDATE players SET user_id = NULL WHERE id = ${keep}`;
    // dup stays linked: its account moves to the kept player on merge.
  });

  it("moves open-game rows to the kept player and leaves closed games untouched", async () => {
    await asUser(t.db, host, (tx) =>
      tx.delete(s.gameEntries).where(sql`${s.gameEntries.gameId} = ${gOpenBoth} AND ${s.gameEntries.playerId} = ${dup}`),
    );
    const before = await t.admin`SELECT game_id, player_id, total_in, cash_out FROM game_entries WHERE game_id IN (${gClosedDup}, ${gClosedBoth}) ORDER BY game_id, player_id`;

    await asUser(t.db, host, (tx) => mergePlayers(tx, keep, dup));

    const [d] = await t.admin`SELECT merged_into, user_id FROM players WHERE id = ${dup}`;
    expect(d!.merged_into).toBe(keep);
    expect(d!.user_id).toBeNull();
    const [k] = await t.admin`SELECT user_id FROM players WHERE id = ${keep}`;
    expect(k!.user_id).toBe(stranger);

    const open = await t.admin`SELECT player_id FROM game_entries WHERE game_id = ${gOpenDup} ORDER BY player_id`;
    expect(open.map((r) => r.player_id).sort()).toEqual([keep, pHost].sort());
    const ev = await t.admin`SELECT count(*)::int AS n FROM game_events WHERE game_id = ${gOpenDup} AND player_id = ${dup}`;
    expect(ev[0]!.n).toBe(0);

    const after = await t.admin`SELECT game_id, player_id, total_in, cash_out FROM game_entries WHERE game_id IN (${gClosedDup}, ${gClosedBoth}) ORDER BY game_id, player_id`;
    expect(after).toEqual(before);
    const [g] = await t.admin`SELECT hash FROM games WHERE id = ${gClosedDup}`;
    expect(g!.hash).toBe(frozenHash);
    // The freeze triggers are still in force.
    expect(await pgError(t.admin`UPDATE game_entries SET player_id = ${keep} WHERE game_id = ${gClosedDup} AND player_id = ${dup}`)).toMatch(
      /closed and cannot be changed/,
    );
  });

  it("statistics count the duplicate's frozen rows under the kept player", async () => {
    const rows = await asUser(t.db, host, (tx) => resultRows(tx, homeId));
    expect(rows.some((r) => r.playerId === dup)).toBe(false);
    const mine = rows.filter((r) => r.playerId === keep);
    expect(mine.map((r) => [r.gameId, r.name, r.totalIn, r.cashOut])).toEqual([
      [gClosedDup, "Ali", 100, 300],
      // Both sat in this game: one row, summed.
      [gClosedBoth, "Ali", 200, 150],
    ]);
    const ali = homeStats(rows).leaderboard.find((p) => p.playerId === keep)!;
    expect(ali.games).toBe(2);
    expect(ali.net).toBe(200 - 50);

    const h = await asUser(t.db, host, (tx) => history(tx, { player: "Ali" }));
    expect(h.every((r) => r.playerId === keep && r.player === "Ali")).toBe(true);
    expect(h).toHaveLength(3);
  });

  it("open debts follow the kept player", async () => {
    const debts = await asUser(t.db, host, (tx) => ledger(tx, homeId));
    expect(debts.length).toBeGreaterThan(0);
    expect(debts.some((d) => d.from === dup || d.to === dup)).toBe(false);
    expect(debts.some((d) => d.to === keep)).toBe(true);
    // The duplicate owed the kept player in the game both sat in: that is owed to oneself now.
    expect(debts.some((d) => d.from === d.to)).toBe(false);
  });

  it("a merged player cannot join a game again or be merged twice", async () => {
    const g = await asUser(t.db, host, (tx) => createGame(tx, host, homeId, 10));
    expect(await pgError(asUser(t.db, host, (tx) => addToGame(tx, host, g.id, dup)))).toMatch(/merged/);
    expect(await pgError(asUser(t.db, host, (tx) => mergePlayers(tx, pHost, dup)))).toMatch(/merged/);
    expect(await pgError(asUser(t.db, host, (tx) => mergePlayers(tx, dup, pHost)))).toMatch(/merged/);
  });

  it("an earlier merge into the duplicate follows the next merge", async () => {
    const [x, y] = await asUser(t.db, host, async (tx) => [(await addPlayer(tx, homeId, "X")).id, (await addPlayer(tx, homeId, "Y")).id]);
    await asUser(t.db, host, (tx) => mergePlayers(tx, x!, y!));
    await asUser(t.db, host, (tx) => mergePlayers(tx, keep, x!));
    const rows = await t.admin`SELECT id, merged_into FROM players WHERE id IN (${x!}, ${y!})`;
    expect(rows.every((r) => r.merged_into === keep)).toBe(true);
  });
});
