// Special ideas: referee log, fair draw, cross-home netting, voice rebuy requests for a named
// player, good-payer index and the night story. RLS: allowed and refused cases for each.
import { createHash, randomUUID } from "node:crypto";
import { drawCommit, drawOrder } from "@poker/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asJobs, asUser } from "../src/client";
import {
  addRuling,
  answerNetting,
  cancelNetting,
  contributeToDraw,
  drawDetails,
  gameStory,
  goodPayerIndex,
  listNetting,
  listRulings,
  nettingCandidates,
  nightFacts,
  proposeNetting,
  revealDraw,
  saveStory,
  setHomeSettings,
  startDraw,
} from "../src/ideas";
import { pendingRequests, requestRebuyFor } from "../src/live";
import { addPlayer, addToGame, closeGame, createGame, createHome, ledger, markPaid, rebuy, setCashOut } from "../src/repo";
import * as s from "../src/schema";
import { type TestDb, freshDb, pgError } from "./helpers";

let t: TestDb;
let A: string; // hosts home X
let B: string; // hosts home Y
let C: string; // member of X, not in the live game
let D: string; // stranger
let homeX: string;
let homeY: string;
let pA: string;
let pB: string;
let pC: string;
let qA: string;
let qB: string;
let liveX: string;

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

async function link(homeId: string, userId: string, playerId: string, role: "member" | "owner" = "member") {
  await t.admin`UPDATE players SET user_id = ${userId} WHERE id = ${playerId}`;
  if (role === "member") {
    await t.admin`INSERT INTO home_members(home_id, user_id, role, player_id) VALUES (${homeId}, ${userId}, 'member', ${playerId})`;
  } else {
    await t.admin`UPDATE home_members SET player_id = ${playerId} WHERE home_id = ${homeId} AND user_id = ${userId}`;
  }
}

/** Play and close a game: rows are [player, in, out]. */
async function playAndClose(host: string, homeId: string, rows: [string, number, number][]) {
  return asUser(t.db, host, async (tx) => {
    const g = await createGame(tx, host, homeId, 0);
    for (const [p, inn, out] of rows) {
      await addToGame(tx, host, g.id, p, inn);
      await setCashOut(tx, host, g.id, p, out);
    }
    const [v] = await tx.select({ version: s.games.version }).from(s.games).where(eq(s.games.id, g.id));
    await closeGame(tx, host, { gameId: g.id, closeKey: randomUUID(), expectedVersion: v!.version, carryDebts: false });
    return g.id;
  });
}

async function settlementOf(gameId: string) {
  const [s] = await t.admin`SELECT id FROM settlements WHERE game_id = ${gameId}`;
  return s!.id as string;
}

beforeAll(async () => {
  t = await freshDb();
  A = await t.newUser("pro");
  B = await t.newUser("pro");
  C = await t.newUser("free");
  D = await t.newUser("free");
  await asUser(t.db, A, async (tx) => {
    homeX = (await createHome(tx, A, { name: "Friday" })).id;
    pA = (await addPlayer(tx, homeX, "Hadi")).id;
    pB = (await addPlayer(tx, homeX, "Abol")).id;
    pC = (await addPlayer(tx, homeX, "Reza")).id;
  });
  await asUser(t.db, B, async (tx) => {
    homeY = (await createHome(tx, B, { name: "Sunday" })).id;
    qA = (await addPlayer(tx, homeY, "Hadi")).id;
    qB = (await addPlayer(tx, homeY, "Abol")).id;
  });
  await link(homeX, A, pA, "owner");
  await link(homeX, B, pB);
  await link(homeX, C, pC);
  await link(homeY, B, qB, "owner");
  await link(homeY, A, qA);
  liveX = await asUser(t.db, A, async (tx) => {
    const g = await createGame(tx, A, homeX, 100);
    await addToGame(tx, A, g.id, pA);
    await addToGame(tx, A, g.id, pB);
    return g.id;
  });
});
afterAll(() => t.close());

// ---------------------------------------------------------------- referee

describe("companion referee log", () => {
  const dispute = {
    variant: "holdem" as const,
    board: "Kh Kd 9c 9s 4d",
    hands: [
      { label: "Hadi", cards: "Qc 4h" },
      { label: "Abol", cards: "Ac 2h" },
    ],
  };

  it("a player in the game records a verdict with its reason and rule", async () => {
    const r = await asUser(t.db, B, (tx) => addRuling(tx, B, liveX, dispute));
    expect(r.winners).toEqual(["Abol"]);
    expect(r.situation).toBe("threePairs");
    expect(r.decidedBy).toEqual({ kind: "tiebreak", index: 2 });
    expect(r.hands[1]!.best).toEqual(["Kh", "Kd", "9c", "9s", "Ac"]);
  });

  it("the host may too; bad cards are refused before anything is written", async () => {
    await asUser(t.db, A, (tx) => addRuling(tx, A, liveX, { ...dispute, board: "Kh Kd 9c 9s" }, "telegram")).catch((e) => {
      expect(e.code).toBe("INVALID");
    });
    await asUser(t.db, A, (tx) => addRuling(tx, A, liveX, dispute, "telegram"));
    expect(await asUser(t.db, C, (tx) => listRulings(tx, liveX))).toHaveLength(2);
  });

  it("a member who is not in the game, and a stranger, cannot add one", async () => {
    expect(await pgError(asUser(t.db, C, (tx) => addRuling(tx, C, liveX, dispute)))).toMatch(/row-level security/);
    expect(await pgError(asUser(t.db, D, (tx) => addRuling(tx, D, liveX, dispute)))).toMatch(/NOT_FOUND/);
    expect(await asUser(t.db, D, (tx) => listRulings(tx, liveX))).toHaveLength(0);
  });

  it("the log is append-only, even for direct database access", async () => {
    expect(await pgError(t.admin`UPDATE game_rulings SET winners = ARRAY['Hadi']`)).toMatch(/append-only/);
    expect(await pgError(t.admin`DELETE FROM game_rulings`)).toMatch(/append-only/);
  });
});

// ---------------------------------------------------------------- fair draw

describe("fair draw", () => {
  let drawId: string;
  const seed = hex("server seed");

  it("only the host starts a draw; members see the commit but never the secret", async () => {
    expect(await pgError(asUser(t.db, B, (tx) => startDraw(tx, liveX)))).toMatch(/not allowed/);
    drawId = await asUser(t.db, A, (tx) => startDraw(tx, liveX, seed));
    const d = await asUser(t.db, B, (tx) => drawDetails(tx, drawId));
    expect(d!.draw.commit).toBe(await drawCommit(seed));
    expect(d!.draw.seed).toBeNull();
    expect(d!.check).toBeNull();
    expect([...d!.draw.players].sort()).toEqual([pA, pB].sort());
    expect(await pgError(asUser(t.db, A, (tx) => tx.execute("SELECT seed_secret FROM game_draws")))).toMatch(/permission denied/);
    // One open draw per game.
    expect(await pgError(asUser(t.db, A, (tx) => startDraw(tx, liveX)))).toMatch(/duplicate key/);
  });

  it("players add their own randomness once; others cannot", async () => {
    await asUser(t.db, B, (tx) => contributeToDraw(tx, B, drawId, hex("abol's phone")));
    const again = await asUser(t.db, B, (tx) => contributeToDraw(tx, B, drawId, hex("again"))).catch((e) => e);
    expect(again.code).toBe("ALREADY_ANSWERED");
    const c = await asUser(t.db, C, (tx) => contributeToDraw(tx, C, drawId, hex("reza"))).catch((e) => e);
    expect(c.code).toBe("NOT_IN_GAME");
    // Going around the function: RLS refuses a contribution for someone else's player.
    expect(
      await pgError(t.db.transaction(async (tx) => {
        await tx.execute("SET LOCAL ROLE app_user");
        await tx.execute(`SELECT set_config('app.user_id', '${C}', true)`);
        await tx.execute(`INSERT INTO draw_contributions(draw_id, player_id, user_id, value) VALUES ('${drawId}', '${pA}', '${C}', '${hex("x")}')`);
      })),
    ).toMatch(/row-level security/);
  });

  it("the host reveals; anyone recomputes the same order", async () => {
    expect(await pgError(asUser(t.db, B, (tx) => revealDraw(tx, drawId)))).toMatch(/not allowed/);
    expect(await asUser(t.db, A, (tx) => revealDraw(tx, drawId))).toBe(liveX);
    const d = (await asUser(t.db, B, (tx) => drawDetails(tx, drawId)))!;
    expect(d.draw.seed).toBe(seed);
    expect(d.check!.commitOk).toBe(true);
    const expected = await drawOrder({ seed, players: [pA, pB], contributions: [{ playerId: pB, value: hex("abol's phone") }] });
    expect(d.check!.result.order).toEqual(expected.order);
    // Closed for contributions and for a second reveal.
    const late = await asUser(t.db, A, (tx) => contributeToDraw(tx, A, drawId, hex("late"))).catch((e) => e);
    expect(late.code).toBe("ALREADY_ANSWERED");
    expect(await pgError(asUser(t.db, A, (tx) => revealDraw(tx, drawId)))).toMatch(/already revealed/);
  });

  it("a draw cannot be rewritten, even with direct database access", async () => {
    expect(await pgError(t.admin`UPDATE game_draws SET players = players[1:1] || players[2:2] WHERE id = ${drawId}`)).toMatch(/cannot be changed/);
    expect(await pgError(t.admin`DELETE FROM draw_contributions`)).toMatch(/append-only/);
  });
});

// ---------------------------------------------------------------- voice rebuy requests

describe("rebuy request for a named player (voice)", () => {
  it("the host may ask for any player; the player for themselves; nobody else", async () => {
    const r = await asUser(t.db, A, (tx) => requestRebuyFor(tx, A, liveX, pB, 50_000, { via: "voice" }));
    expect(r.amount).toBe(50_000);
    expect((await asUser(t.db, A, (tx) => pendingRequests(tx, liveX))).map((x) => x.playerId)).toEqual([pB]);
    const twice = await asUser(t.db, B, (tx) => requestRebuyFor(tx, B, liveX, pB)).catch((e) => e);
    expect(twice.code).toBe("ALREADY_REQUESTED");
    const other = await asUser(t.db, B, (tx) => requestRebuyFor(tx, B, liveX, pA)).catch((e) => e);
    expect(other.code).toBe("FORBIDDEN");
    const [ev] = await t.admin`SELECT details FROM game_events WHERE id = ${r.requestId}`;
    expect(ev!.details).toEqual({ via: "voice" });
  });
});

// ---------------------------------------------------------------- netting

describe("cross-home debt netting", () => {
  let xGame: string;
  let yGame: string;
  let aOwesB: string; // in X, 100
  let bOwesA: string; // in Y, 60

  beforeAll(async () => {
    xGame = await playAndClose(A, homeX, [
      [pA, 100, 0],
      [pB, 100, 200],
    ]);
    yGame = await playAndClose(B, homeY, [
      [qA, 100, 160],
      [qB, 100, 40],
    ]);
    aOwesB = await settlementOf(xGame);
    bOwesA = await settlementOf(yGame);
  });

  it("finds the pair for both people", async () => {
    const forA = await asUser(t.db, A, (tx) => nettingCandidates(tx, A));
    expect(forA).toHaveLength(1);
    expect(forA[0]).toMatchObject({ otherUserId: B, amount: 60, mine: { settlementId: aOwesB }, theirs: { settlementId: bOwesA } });
    const forB = await asUser(t.db, B, (tx) => nettingCandidates(tx, B));
    expect(forB[0]).toMatchObject({ otherUserId: A, mine: { settlementId: bOwesA }, theirs: { settlementId: aOwesB } });
    expect(await asUser(t.db, C, (tx) => nettingCandidates(tx, C))).toEqual([]);
  });

  it("refuses the wrong direction, outsiders and made-up pairs", async () => {
    expect(await pgError(asUser(t.db, A, (tx) => proposeNetting(tx, bOwesA, aOwesB)))).toMatch(/not possible/);
    expect(await pgError(asUser(t.db, C, (tx) => proposeNetting(tx, aOwesB, bOwesA)))).toMatch(/not possible/);
    expect(await pgError(asUser(t.db, D, (tx) => proposeNetting(tx, aOwesB, bOwesA)))).toMatch(/not possible/);
    expect(await pgError(asUser(t.db, A, (tx) => proposeNetting(tx, aOwesB, aOwesB)))).toMatch(/not possible/);
    // Nobody can write proposals or netted payments directly.
    expect(
      await pgError(asUser(t.db, A, (tx) => tx.execute(`INSERT INTO debt_payments(settlement_id, kind, amount, netting_id, marked_by) VALUES ('${aOwesB}', 'netted', 60, '${randomUUID()}', '${A}')`))),
    ).toMatch(/row-level security|violates/);
  });

  it("the proposer cannot accept their own proposal; outsiders do not see it", async () => {
    const p = await asUser(t.db, A, (tx) => proposeNetting(tx, aOwesB, bOwesA));
    expect(await pgError(asUser(t.db, A, (tx) => answerNetting(tx, p, true)))).toMatch(/not allowed/);
    expect(await pgError(asUser(t.db, C, (tx) => answerNetting(tx, p, true)))).toMatch(/not found/);
    expect(await asUser(t.db, C, (tx) => listNetting(tx))).toEqual([]);
    expect(await asUser(t.db, D, (tx) => listNetting(tx))).toEqual([]);
    const forB = await asUser(t.db, B, (tx) => listNetting(tx, { homeId: homeX, status: "pending" }));
    expect(forB).toHaveLength(1);
    expect(forB[0]!.a).toMatchObject({ homeName: "Friday", from: "Hadi", to: "Abol" });
    // A second identical proposal while one is pending is refused; the proposer can withdraw.
    expect(await pgError(asUser(t.db, A, (tx) => proposeNetting(tx, aOwesB, bOwesA)))).toMatch(/duplicate key/);
    await asUser(t.db, A, (tx) => cancelNetting(tx, p));
    expect(await pgError(asUser(t.db, B, (tx) => answerNetting(tx, p, true)))).toMatch(/already answered/);
  });

  it("two accepts at the same time record the netting once", async () => {
    const hashes = await t.admin`SELECT id, hash FROM games WHERE id IN (${xGame}, ${yGame}) ORDER BY id`;
    const p = await asUser(t.db, B, (tx) => proposeNetting(tx, bOwesA, aOwesB));
    const results = await Promise.allSettled([
      asUser(t.db, A, (tx) => answerNetting(tx, p, true)),
      asUser(t.db, A, (tx) => answerNetting(tx, p, true)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const payments = await t.admin`SELECT settlement_id, amount FROM debt_payments WHERE netting_id = ${p} ORDER BY amount`;
    expect(payments.map((x) => [x.settlement_id, Number(x.amount)]).sort()).toEqual([
      [aOwesB, 60],
      [bOwesA, 60],
    ].sort());
    // B's debt in Y is gone; A still owes B 40 in X. The frozen games did not change.
    expect(await asUser(t.db, B, (tx) => ledger(tx, homeY))).toEqual([]);
    const lx = await asUser(t.db, B, (tx) => ledger(tx, homeX));
    expect(lx.map((d) => [d.settlementId, d.amount, d.original])).toEqual([[aOwesB, 40, 100]]);
    expect(await t.admin`SELECT id, hash FROM games WHERE id IN (${xGame}, ${yGame}) ORDER BY id`).toEqual(hashes);
    expect(await asUser(t.db, A, (tx) => nettingCandidates(tx, A))).toEqual([]);
  });

  it("the rest is paid as usual; a settled debt cannot be netted or paid again", async () => {
    await asUser(t.db, B, (tx) => markPaid(tx, B, aOwesB));
    expect(await asUser(t.db, A, (tx) => ledger(tx, homeX))).toEqual([]);
    expect(await pgError(asUser(t.db, B, (tx) => markPaid(tx, B, aOwesB)))).toMatch(/duplicate key|already settled/);
    expect(await pgError(asUser(t.db, A, (tx) => proposeNetting(tx, aOwesB, bOwesA)))).toMatch(/not possible/);
    // Payments are records: netted ones cannot be removed.
    expect(
      await asUser(t.db, A, (tx) => tx.execute(`DELETE FROM debt_payments WHERE kind = 'netted' RETURNING id`)),
    ).toHaveLength(0);
  });

  it("a proposal made stale by a payment is refused on accept", async () => {
    const x2 = await playAndClose(A, homeX, [
      [pA, 100, 70],
      [pB, 100, 130],
    ]);
    const y2 = await playAndClose(B, homeY, [
      [qA, 100, 150],
      [qB, 100, 50],
    ]);
    const s1 = await settlementOf(x2);
    const s2 = await settlementOf(y2);
    const p = await asUser(t.db, A, (tx) => proposeNetting(tx, s1, s2));
    await asUser(t.db, A, (tx) => markPaid(tx, A, s2));
    expect(await pgError(asUser(t.db, B, (tx) => answerNetting(tx, p, true)))).toMatch(/more than the open debt/);
    await asUser(t.db, B, (tx) => answerNetting(tx, p, false));
    const [row] = await t.admin`SELECT status FROM netting_proposals WHERE id = ${p}`;
    expect(row!.status).toBe("declined");
  });
});

// ---------------------------------------------------------------- good-payer index

describe("good-payer index", () => {
  it("is off until the host turns it on, and only the host can", async () => {
    expect(await asUser(t.db, B, (tx) => goodPayerIndex(tx, homeX))).toBeNull();
    expect(await pgError(asUser(t.db, B, (tx) => setHomeSettings(tx, homeX, { goodPayerIndex: true })))).toMatch(/NOT_FOUND/);
    await asUser(t.db, A, (tx) => setHomeSettings(tx, homeX, { goodPayerIndex: true }));
    const [h] = await t.admin`SELECT settings FROM homes WHERE id = ${homeX}`;
    expect(h!.settings).toMatchObject({ goodPayerIndex: true });
  });

  it("shows average days to pay, inside the home only", async () => {
    // Hadi's debt of game 1 in X was settled (60 netted + the rest paid).
    const idx = (await asUser(t.db, B, (tx) => goodPayerIndex(tx, homeX)))!;
    const hadi = idx.find((x) => x.name === "Hadi")!;
    expect(hadi.debts).toBe(1);
    expect(hadi.averageDays).toBeGreaterThanOrEqual(0);
    expect(hadi.averageDays).toBeLessThan(1);
    // Strangers see nothing, and home Y (setting off) shows nothing.
    expect(await asUser(t.db, D, (tx) => goodPayerIndex(tx, homeX))).toBeNull();
    expect(await asUser(t.db, A, (tx) => goodPayerIndex(tx, homeY))).toBeNull();
  });
});

// ---------------------------------------------------------------- night story

describe("night story", () => {
  let closed: string;
  beforeAll(async () => {
    closed = await asUser(t.db, A, async (tx) => {
      const g = await createGame(tx, A, homeX, 100);
      await addToGame(tx, A, g.id, pA);
      await addToGame(tx, A, g.id, pC);
      await rebuy(tx, A, g.id, pA, 100);
      await setCashOut(tx, A, g.id, pA, 50);
      await setCashOut(tx, A, g.id, pC, 250);
      const [v] = await tx.select({ version: s.games.version }).from(s.games).where(eq(s.games.id, g.id));
      await closeGame(tx, A, { gameId: g.id, closeKey: randomUUID(), expectedVersion: v!.version, carryDebts: false });
      return g.id;
    });
  });

  it("facts come from the game only", async () => {
    const f = (await asJobs(t.db, (tx) => nightFacts(tx, closed)))!;
    expect(f.rows.map((r) => [r.name, r.totalIn, r.net, r.rebuys]).sort()).toEqual([
      ["Hadi", 200, -150, 1],
      ["Reza", 100, 150, 0],
    ]);
    expect(f.biggestRebuy).toBe(100);
    expect(await asJobs(t.db, (tx) => nightFacts(tx, liveX))).toBeNull();
  });

  it("is written once by the background role, read by members, never changed", async () => {
    const v = { gameId: closed, homeId: homeX, locale: "en", body: "Reza took the night.", model: "m" };
    expect(await asJobs(t.db, (tx) => saveStory(tx, v))).toBe(true);
    expect(await asJobs(t.db, (tx) => saveStory(tx, { ...v, body: "again" }))).toBe(false);
    expect((await asUser(t.db, C, (tx) => gameStory(tx, closed)))!.body).toBe("Reza took the night.");
    expect(await asUser(t.db, D, (tx) => gameStory(tx, closed))).toBeNull();
    expect(await pgError(asUser(t.db, A, (tx) => saveStory(tx, { ...v, gameId: liveX })))).toMatch(/permission denied/);
    expect(await pgError(asJobs(t.db, (tx) => saveStory(tx, { ...v, gameId: liveX })))).toMatch(/row-level security/);
    expect(await pgError(t.admin`UPDATE game_stories SET body = 'x'`)).toMatch(/append-only/);
  });

  it("a closed game refuses new rulings but keeps its log readable", async () => {
    const dispute = { variant: "holdem" as const, board: "Kh Kd 9c 9s 4d", hands: [{ label: "", cards: "Qc 4h" }, { label: "", cards: "Ac 2h" }] };
    const e = await asUser(t.db, A, (tx) => addRuling(tx, A, closed, dispute)).catch((x) => x);
    expect(e.code).toBe("FROZEN");
    expect(
      await pgError(asUser(t.db, A, (tx) =>
        tx.execute(
          `INSERT INTO game_rulings(game_id, home_id, variant, board, hands, winners, decided_by, actor_id) VALUES ('${closed}', '${homeX}', 'holdem', ARRAY['As','Ks','Qs','Js','Ts'], '[{},{}]', ARRAY['1'], '{}', '${A}')`,
        ),
      )),
    ).toMatch(/row-level security/);
  });
});
