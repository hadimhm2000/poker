import { describe, expect, it } from "vitest";
import { parseCards } from "../src/cards";
import { type PotPlayer, awardPots, buildPots, resolveHand, winnersFromCards } from "../src/sidepot";

const P = (id: string, contributed: number, folded = false): PotPlayer => ({ id, contributed, folded });
const seat = (players: PotPlayer[], button = players[0]!.id) => ({ seatOrder: players.map((p) => p.id), button });
const total = (xs: { amount: number }[]) => xs.reduce((a, b) => a + b.amount, 0);

describe("the plan's example", () => {
  // A 100 all-in, B 300 all-in, C and D 500 each, E put in 50 and folded. Total 1,450.
  const players = [P("A", 100), P("B", 300), P("C", 500), P("D", 500), P("E", 50, true)];

  it("builds main 450, side 600, side 400", () => {
    const pots = buildPots(players);
    expect(pots.map((p) => [p.amount, p.eligible])).toEqual([
      [450, ["A", "B", "C", "D"]],
      [600, ["B", "C", "D"]],
      [400, ["C", "D"]],
    ]);
    expect(total(pots)).toBe(1450);
  });

  it("A with the best hand only wins the main pot; side pots are compared separately", () => {
    const r = resolveHand(players, [["A"], ["C"], ["D"]], seat(players));
    expect(Object.fromEntries(r.payouts.map((p) => [p.playerId, p.amount]))).toEqual({ A: 450, C: 600, D: 400 });
    expect(total(r.payouts)).toBe(1450);
    expect(total(r.net)).toBe(0);
  });
});

interface Scenario {
  name: string;
  players: PotPlayer[];
  pots: [number, string[]][];
  winners?: string[][];
  payouts?: Record<string, number>;
  button?: string;
  chipUnit?: number;
}

const scenarios: Scenario[] = [
  { name: "heads-up, equal stacks", players: [P("a", 200), P("b", 200)], pots: [[400, ["a", "b"]]], winners: [["a"]], payouts: { a: 400 } },
  { name: "heads-up, short stack all-in, excess returned", players: [P("a", 100), P("b", 300)], pots: [[200, ["a", "b"]], [200, ["b"]]], winners: [["a"]], payouts: { a: 200, b: 200 } },
  { name: "heads-up, big stack wins everything", players: [P("a", 100), P("b", 300)], pots: [[200, ["a", "b"]], [200, ["b"]]], winners: [["b"]], payouts: { b: 400 } },
  { name: "everyone folds to one player", players: [P("a", 10, true), P("b", 20, true), P("c", 40)], pots: [[70, ["c"]]], winners: [["c"]], payouts: { c: 70 } },
  { name: "three-way equal", players: [P("a", 100), P("b", 100), P("c", 100)], pots: [[300, ["a", "b", "c"]]], winners: [["b"]], payouts: { b: 300 } },
  { name: "three-way two short stacks", players: [P("a", 50), P("b", 100), P("c", 100)], pots: [[150, ["a", "b", "c"]], [100, ["b", "c"]]], winners: [["a"], ["c"]], payouts: { a: 150, c: 100 } },
  { name: "three different stacks", players: [P("a", 50), P("b", 150), P("c", 300)], pots: [[150, ["a", "b", "c"]], [200, ["b", "c"]], [150, ["c"]]], winners: [["a"], ["b"]], payouts: { a: 150, b: 200, c: 150 } },
  { name: "folded players money goes to the pots it reached", players: [P("a", 100), P("b", 300), P("f", 200, true)], pots: [[300, ["a", "b"]], [300, ["b"]]], winners: [["a"]], payouts: { a: 300, b: 300 } },
  { name: "folded player dead money above every active level", players: [P("a", 100), P("b", 100), P("f", 150, true)], pots: [[350, ["a", "b"]]], winners: [["a"]], payouts: { a: 350 } },
  { name: "split main pot, odd chip left of button", players: [P("a", 25), P("b", 25), P("c", 25, true)], pots: [[75, ["a", "b"]]], winners: [["a", "b"]], button: "a", payouts: { b: 38, a: 37 } },
  { name: "the plan's odd chip: 25 between two → 13 and 12", players: [P("x", 12), P("y", 13)], pots: [[24, ["x", "y"]], [1, ["y"]]], winners: [["x", "y"]], button: "y", payouts: { x: 12, y: 13 } },
  { name: "three-way split with remainder 2", players: [P("a", 100), P("b", 100), P("c", 100), P("d", 2, true)], pots: [[302, ["a", "b", "c"]]], winners: [["a", "b", "c"]], button: "c", payouts: { a: 101, b: 101, c: 100 } },
  { name: "odd chip in chip units of 25", players: [P("a", 125), P("b", 125), P("c", 25, true)], pots: [[275, ["a", "b"]]], winners: [["a", "b"]], button: "b", chipUnit: 25, payouts: { a: 150, b: 125 } },
  { name: "split side pot only", players: [P("a", 50), P("b", 200), P("c", 200)], pots: [[150, ["a", "b", "c"]], [300, ["b", "c"]]], winners: [["a"], ["b", "c"]], payouts: { a: 150, b: 150, c: 150 } },
  { name: "short stack wins main, big stacks tie side", players: [P("a", 10), P("b", 40), P("c", 40), P("d", 40)], pots: [[40, ["a", "b", "c", "d"]], [90, ["b", "c", "d"]]], winners: [["a"], ["b", "d"]], button: "d", payouts: { a: 40, b: 45, d: 45 } },
  { name: "four levels", players: [P("a", 10), P("b", 20), P("c", 30), P("d", 40)], pots: [[40, ["a", "b", "c", "d"]], [30, ["b", "c", "d"]], [20, ["c", "d"]], [10, ["d"]]], winners: [["a"], ["b"], ["c"]], payouts: { a: 40, b: 30, c: 20, d: 10 } },
  { name: "biggest stack best hand collects all", players: [P("a", 10), P("b", 20), P("c", 30), P("d", 40)], pots: [[40, ["a", "b", "c", "d"]], [30, ["b", "c", "d"]], [20, ["c", "d"]], [10, ["d"]]], winners: [["d"], ["d"], ["d"]], payouts: { d: 100 } },
  { name: "two players same all-in amount", players: [P("a", 100), P("b", 100), P("c", 300), P("d", 300)], pots: [[400, ["a", "b", "c", "d"]], [400, ["c", "d"]]], winners: [["a", "b"], ["c"]], payouts: { a: 200, b: 200, c: 400 } },
  { name: "zero contribution checker is eligible for main", players: [P("a", 0), P("b", 0)], pots: [[0, ["a", "b"]]], winners: [["a"]], payouts: { a: 0 } },
  { name: "folded big blind, uncalled raise returned", players: [P("sb", 10, true), P("bb", 20, true), P("btn", 60)], pots: [[90, ["btn"]]], winners: [["btn"]], payouts: { btn: 90 } },
  { name: "uncalled excess after a call", players: [P("a", 100), P("b", 250), P("c", 100, true)], pots: [[300, ["a", "b"]], [150, ["b"]]], winners: [["a"]], payouts: { a: 300, b: 150 } },
  { name: "many folded", players: [P("a", 5, true), P("b", 5, true), P("c", 5, true), P("d", 50), P("e", 50)], pots: [[115, ["d", "e"]]], winners: [["e"]], payouts: { e: 115 } },
  { name: "six-way with two all-ins", players: [P("a", 30), P("b", 80), P("c", 200), P("d", 200), P("e", 10, true), P("f", 200)], pots: [[160, ["a", "b", "c", "d", "f"]], [200, ["b", "c", "d", "f"]], [360, ["c", "d", "f"]]], winners: [["b"], ["b"], ["f"]], payouts: { b: 360, f: 360 } },
];

describe("side pot scenarios", () => {
  for (const s of scenarios) {
    it(s.name, () => {
      const pots = buildPots(s.players);
      expect(pots.map((p) => [p.amount, p.eligible])).toEqual(s.pots);
      expect(total(pots)).toBe(total(s.players.map((p) => ({ amount: p.contributed }))));
      if (s.winners) {
        const payouts = awardPots(pots, s.winners, { ...seat(s.players, s.button), chipUnit: s.chipUnit });
        const got = Object.fromEntries(payouts.filter((p) => p.amount || s.payouts![p.playerId] === 0).map((p) => [p.playerId, p.amount]));
        expect(got).toEqual(s.payouts);
        expect(total(payouts)).toBe(total(pots));
      }
    });
  }

  it("refuses a winner who is not eligible for that pot", () => {
    const players = [P("a", 100), P("b", 300), P("c", 300)];
    expect(() => awardPots(buildPots(players), [["a"], ["a"]], seat(players))).toThrow(/not eligible/);
  });

  it("refuses when everyone folded or input is bad", () => {
    expect(() => buildPots([P("a", 10, true)])).toThrow();
    expect(() => buildPots([P("a", -1)])).toThrow();
    expect(() => buildPots([P("a", 1.5)])).toThrow();
    expect(() => buildPots([P("a", 1), P("a", 1)])).toThrow(/duplicate/);
  });
});

describe("side pots decided by the hand engine", () => {
  it("A has the nuts but only wins the main pot", () => {
    const players = [P("A", 100), P("B", 300), P("C", 500), P("D", 500), P("E", 50, true)];
    const pots = buildPots(players);
    const holes = new Map(
      Object.entries({ A: "As Ah", B: "Ks Kh", C: "Qs Qh", D: "2c 7d" }).map(([k, v]) => [k, parseCards(v)]),
    );
    const winners = winnersFromCards(pots, "holdem", parseCards("Ad Kd 5c 8s 9h"), holes);
    expect(winners).toEqual([["A"], ["B"], ["C"]]);
    const payouts = awardPots(pots, winners, seat(players));
    expect(Object.fromEntries(payouts.map((p) => [p.playerId, p.amount]))).toEqual({ A: 450, B: 600, C: 400 });
  });
});

describe("randomised invariants (200 hands)", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  for (let round = 0; round < 200; round++) {
    const n = 2 + Math.floor(rand() * 8);
    const players = Array.from({ length: n }, (_, i) => P(`p${i}`, Math.floor(rand() * 40) * 5, rand() < 0.3));
    if (players.every((p) => p.folded)) players[0]!.folded = false;
    it(`hand #${round} (${n} players)`, () => {
      const pots = buildPots(players);
      const contributed = total(players.map((p) => ({ amount: p.contributed })));
      expect(total(pots)).toBe(contributed);
      for (const pot of pots) {
        for (const id of pot.eligible) {
          const p = players.find((x) => x.id === id)!;
          expect(p.folded).toBe(false);
          expect(p.contributed).toBeGreaterThanOrEqual(pot.cap);
        }
      }
      // Random winners, with random ties
      const winners = pots.map((pot) => pot.eligible.filter(() => rand() < 0.5).concat(pot.eligible[0]!));
      const button = players[Math.floor(rand() * n)]!.id;
      const payouts = awardPots(pots, winners, { seatOrder: players.map((p) => p.id), button });
      expect(total(payouts)).toBe(contributed);
      // Nobody wins more from an opponent than they themselves put in (per-pot capping).
      for (const p of payouts) {
        const me = players.find((x) => x.id === p.playerId)!;
        const maxWin = total(players.map((o) => ({ amount: Math.min(o.contributed, me.contributed) })));
        const maxWithDead = maxWin + total(players.filter((o) => o.folded).map((o) => ({ amount: Math.max(0, o.contributed - me.contributed) })));
        expect(p.amount).toBeLessThanOrEqual(maxWithDead);
      }
    });
  }
});
