// Phase 3: live game (QR join, rebuy requests, queued host changes), game nights,
// Telegram link codes and the background-jobs role.
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAuth, asJobs, asUser } from "../src/client";
import {
  answerRequest,
  applyHostOp,
  claimPlayer,
  consumeLinkCode,
  createLinkCode,
  createNight,
  ensureJoinInvite,
  joinGame,
  linkTelegramAccount,
  pendingRequests,
  requestRebuy,
  rsvp,
  upcomingNights,
} from "../src/live";
import { addPlayer, addToGame, createGame, createHome } from "../src/repo";
import * as s from "../src/schema";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
let host: string;
let friend: string;
let stranger: string;
let homeId: string;
let pHost: string;
let pFriend: string;
let gameId: string;

const sha = (x: string) => createHash("sha256").update(x).digest();
const tokenFor = (inviteId: string) => `tok-${inviteId}`;

async function entry(playerId: string) {
  const [e] = await t.admin`SELECT total_in FROM game_entries WHERE game_id = ${gameId} AND player_id = ${playerId}`;
  return Number(e!.total_in);
}

beforeAll(async () => {
  t = await freshDb();
  host = await t.newUser("pro");
  friend = await t.newUser("free");
  stranger = await t.newUser("free");
  await asUser(t.db, host, async (tx) => {
    homeId = (await createHome(tx, host, { name: "Friday" })).id;
    pHost = (await addPlayer(tx, homeId, "Hadi")).id;
    pFriend = (await addPlayer(tx, homeId, "Abol")).id;
    const g = await createGame(tx, host, homeId, 100);
    gameId = g.id;
    await addToGame(tx, host, g.id, pHost);
    await addToGame(tx, host, g.id, pFriend);
  });
});
afterAll(() => t.close());

describe("joining a live game by QR", () => {
  let inviteId: string;

  it("the host's QR link is stable while valid", async () => {
    inviteId = await asUser(t.db, host, (tx) => ensureJoinInvite(tx, host, gameId, (i) => sha(tokenFor(i))));
    const again = await asUser(t.db, host, (tx) => ensureJoinInvite(tx, host, gameId, (i) => sha(tokenFor(i))));
    expect(again).toBe(inviteId);
  });

  it("a member cannot make a join link", async () => {
    expect(await pgError(asUser(t.db, stranger, (tx) => ensureJoinInvite(tx, stranger, gameId, (i) => sha(tokenFor(i)))))).toMatch(/NOT_FOUND/);
  });

  it("scanning makes you a member and lands on the game", async () => {
    const g = await asUser(t.db, friend, (tx) => joinGame(tx, sha(tokenFor(inviteId))));
    expect(g).toBe(gameId);
    const [m] = await t.admin`SELECT role FROM home_members WHERE home_id = ${homeId} AND user_id = ${friend}`;
    expect(m!.role).toBe("member");
  });

  it("a wrong token does nothing", async () => {
    expect(await pgError(asUser(t.db, stranger, (tx) => joinGame(tx, sha("nope"))))).toMatch(/not valid/);
  });

  it("a member claims their account-less player once", async () => {
    await asUser(t.db, friend, (tx) => claimPlayer(tx, gameId, pFriend));
    const [p] = await t.admin`SELECT user_id FROM players WHERE id = ${pFriend}`;
    expect(p!.user_id).toBe(friend);
    // A second player for the same person, or a player someone already owns: refused.
    expect(await pgError(asUser(t.db, friend, (tx) => claimPlayer(tx, gameId, pHost)))).toMatch(/already have a player/);
  });

  it("a non-member cannot claim anyone", async () => {
    expect(await pgError(asUser(t.db, stranger, (tx) => claimPlayer(tx, gameId, pHost)))).toMatch(/not allowed/);
  });
});

describe("rebuy requests", () => {
  it("a player asks, the host approves with one tap", async () => {
    const before = await entry(pFriend);
    const r = await asUser(t.db, friend, (tx) => requestRebuy(tx, friend, gameId));
    expect(r.amount).toBe(100);
    // Asking twice before the host answers: still one request.
    expect(await pgError(asUser(t.db, friend, (tx) => requestRebuy(tx, friend, gameId)))).toMatch(/ALREADY_REQUESTED/);
    const open = await asUser(t.db, host, (tx) => pendingRequests(tx, gameId));
    expect(open.map((o) => o.id)).toEqual([r.requestId]);
    await asUser(t.db, host, (tx) => answerRequest(tx, host, r.requestId, true));
    expect(await entry(pFriend)).toBe(before + 100);
    expect(await asUser(t.db, host, (tx) => pendingRequests(tx, gameId))).toEqual([]);
  });

  it("two devices approving at once add one rebuy", async () => {
    const before = await entry(pFriend);
    const r = await asUser(t.db, friend, (tx) => requestRebuy(tx, friend, gameId, 50));
    const results = await Promise.allSettled([
      asUser(t.db, host, (tx) => answerRequest(tx, host, r.requestId, true)),
      asUser(t.db, host, (tx) => answerRequest(tx, host, r.requestId, true)),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await entry(pFriend)).toBe(before + 50);
  });

  it("a member cannot approve their own request", async () => {
    const r = await asUser(t.db, friend, (tx) => requestRebuy(tx, friend, gameId));
    expect(await pgError(asUser(t.db, friend, (tx) => answerRequest(tx, friend, r.requestId, true)))).toMatch(/row-level security/);
    await asUser(t.db, host, (tx) => answerRequest(tx, host, r.requestId, false));
  });

  it("a stranger cannot ask", async () => {
    expect(await pgError(asUser(t.db, stranger, (tx) => requestRebuy(tx, stranger, gameId)))).toMatch(/NOT_IN_GAME/);
  });
});

describe("changes queued while offline", () => {
  it("sending the same change twice applies it once", async () => {
    const before = await entry(pHost);
    const op = { kind: "rebuy", opKey: randomUUID(), playerId: pHost, amount: 100 };
    expect(await asUser(t.db, host, (tx) => applyHostOp(tx, host, gameId, op))).toEqual({ duplicate: false });
    expect(await asUser(t.db, host, (tx) => applyHostOp(tx, host, gameId, op))).toEqual({ duplicate: true });
    expect(await entry(pHost)).toBe(before + 100);
  });

  it("the same change arriving twice at once applies once", async () => {
    const before = await entry(pHost);
    const op = { kind: "rebuy", opKey: randomUUID(), playerId: pHost, amount: 10 };
    await Promise.allSettled([
      asUser(t.db, host, (tx) => applyHostOp(tx, host, gameId, op)),
      asUser(t.db, host, (tx) => applyHostOp(tx, host, gameId, op)),
    ]);
    expect(await entry(pHost)).toBe(before + 10);
  });

  it("a member's queued change is refused", async () => {
    const op = { kind: "cash_out", opKey: randomUUID(), playerId: pFriend, amount: 999 };
    await asUser(t.db, friend, (tx) => applyHostOp(tx, friend, gameId, op)).catch(() => null);
    const [e] = await t.admin`SELECT cash_out FROM game_entries WHERE game_id = ${gameId} AND player_id = ${pFriend}`;
    expect(e!.cash_out).toBeNull();
  });
});

describe("live updates", () => {
  it("a change wakes listeners with only the game id", async () => {
    const listener = postgres(t.url, { max: 1, onnotice: () => {} });
    const got: string[] = [];
    await listener.listen("game_changed", (payload) => got.push(payload));
    await asUser(t.db, host, (tx) => applyHostOp(tx, host, gameId, { kind: "rebuy", opKey: randomUUID(), playerId: pHost, amount: 1 }));
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
    await listener.end();
    expect(new Set(got)).toEqual(new Set([gameId]));
  });
});

describe("game nights", () => {
  it("the host invites, members answer, strangers cannot", async () => {
    const n = await asUser(t.db, host, (tx) =>
      createNight(tx, host, { homeId, startsAt: new Date(Date.now() + 2 * 864e5), place: "Hadi's" }),
    );
    await asUser(t.db, friend, (tx) => rsvp(tx, friend, n.id, "yes"));
    await asUser(t.db, friend, (tx) => rsvp(tx, friend, n.id, "maybe"));
    expect(await pgError(asUser(t.db, stranger, (tx) => rsvp(tx, stranger, n.id, "yes")))).toMatch(/NOT_FOUND/);
    expect(
      await pgError(asUser(t.db, friend, (tx) => createNight(tx, friend, { homeId, startsAt: new Date(Date.now() + 864e5) }))),
    ).toMatch(/row-level security/);
    const list = await asUser(t.db, friend, (tx) => upcomingNights(tx, homeId));
    expect(list).toHaveLength(1);
    expect(list[0]!.answers).toEqual([{ userId: friend, answer: "maybe", name: "Abol" }]);
  });
});

describe("Telegram link codes", () => {
  it("work once and only for their purpose", async () => {
    const code = sha("code-1");
    await asAuth(t.db, (tx) => createLinkCode(tx, code, { purpose: "account", userId: friend }));
    expect(await asAuth(t.db, (tx) => consumeLinkCode(tx, code, "group"))).toBeNull();
    expect((await asAuth(t.db, (tx) => consumeLinkCode(tx, code, "account")))?.userId).toBe(friend);
    expect(await asAuth(t.db, (tx) => consumeLinkCode(tx, code, "account"))).toBeNull();
  });

  it("one Telegram account cannot be attached to two site accounts", async () => {
    await asAuth(t.db, (tx) => linkTelegramAccount(tx, friend, 777));
    expect(await pgError(asAuth(t.db, (tx) => linkTelegramAccount(tx, stranger, 777)))).toMatch(/TELEGRAM_TAKEN/);
  });

  it("request handlers cannot read link codes", async () => {
    expect(await pgError(asUser(t.db, friend, (tx) => tx.select().from(s.telegramLinkCodes)))).toMatch(/permission denied/);
  });
});

describe("background jobs role", () => {
  it("reads across homes but cannot change games or read secrets", async () => {
    const homes = await asJobs(t.db, (tx) => tx.select({ id: s.homes.id }).from(s.homes));
    expect(homes.map((h) => h.id)).toContain(homeId);
    expect(await pgError(asJobs(t.db, (tx) => tx.select().from(s.sessions)))).toMatch(/permission denied/);
    expect(await pgError(asJobs(t.db, (tx) => tx.select({ p: s.users.passwordHash }).from(s.users)))).toMatch(/permission denied/);
    expect(await pgError(asJobs(t.db, (tx) => tx.update(s.games).set({ defaultBuyIn: 1 }).where(eq(s.games.id, gameId))))).toMatch(
      /permission denied/,
    );
  });
});
