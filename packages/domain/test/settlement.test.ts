import { describe, expect, it } from "vitest";
import { type Balance, balancesWithOpenDebts, settle } from "../src/settlement";

function applied(transfers: ReturnType<typeof settle>) {
  const m = new Map<string, number>();
  for (const t of transfers) {
    m.set(t.from, (m.get(t.from) ?? 0) - t.amount);
    m.set(t.to, (m.get(t.to) ?? 0) + t.amount);
  }
  return m;
}

function expectSettles(balances: Balance[]) {
  const transfers = settle(balances);
  const got = applied(transfers);
  for (const b of balances) expect(got.get(b.playerId) ?? 0).toBe(b.amount);
  for (const t of transfers) expect(t.amount).toBeGreaterThan(0);
  return transfers;
}

/** Brute force: max number of zero-sum groups in a partition. */
function maxGroups(values: number[]): number {
  const n = values.length;
  const memo = new Map<number, number>();
  const go = (mask: number): number => {
    if (mask === 0) return 0;
    if (memo.has(mask)) return memo.get(mask)!;
    const first = mask & -mask;
    const rest = mask ^ first;
    let best = -Infinity;
    for (let sub = rest; ; sub = (sub - 1) & rest) {
      const group = sub | first;
      let s = 0;
      for (let i = 0; i < n; i++) if (group & (1 << i)) s += values[i]!;
      if (s === 0) best = Math.max(best, 1 + go(mask ^ group));
      if (sub === 0) break;
    }
    memo.set(mask, best);
    return best;
  };
  return go((1 << n) - 1);
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe("settle", () => {
  it("returns nothing when everyone is even", () => {
    expect(settle([{ playerId: "a", amount: 0 }])).toEqual([]);
  });

  it("one loser pays two winners", () => {
    const t = expectSettles([
      { playerId: "a", amount: -300 },
      { playerId: "b", amount: 100 },
      { playerId: "c", amount: 200 },
    ]);
    expect(t).toHaveLength(2);
  });

  it("uses independent zero-sum pairs instead of chaining", () => {
    const t = expectSettles([
      { playerId: "a", amount: 500 },
      { playerId: "b", amount: -500 },
      { playerId: "c", amount: 300 },
      { playerId: "d", amount: -300 },
      { playerId: "e", amount: 700 },
      { playerId: "f", amount: -700 },
    ]);
    expect(t).toHaveLength(3);
  });

  it("finds a hidden zero-sum split greedy would miss", () => {
    // greedy pairs largest first: 6 transfers; optimal splits {+7,-4,-3},{+5,-2,-3},{... }
    const values = [7, 5, -4, -3, -2, -3];
    const t = expectSettles(values.map((amount, i) => ({ playerId: `p${i}`, amount })));
    expect(t).toHaveLength(values.length - maxGroups(values));
  });

  it("rejects balances that do not sum to zero", () => {
    expect(() => settle([{ playerId: "a", amount: 5 }])).toThrow();
  });

  it("rejects non-integer money", () => {
    expect(() => settle([{ playerId: "a", amount: 0.5 }, { playerId: "b", amount: -0.5 }])).toThrow();
  });

  it("merges duplicate player ids", () => {
    const t = settle([
      { playerId: "a", amount: 100 },
      { playerId: "a", amount: -100 },
    ]);
    expect(t).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const b: Balance[] = [
      { playerId: "x", amount: -250 },
      { playerId: "y", amount: 100 },
      { playerId: "z", amount: 150 },
    ];
    expect(settle(b)).toEqual(settle([...b].reverse()));
  });

  it("nets open debts from earlier games", () => {
    // a owed b 200 from last week; tonight b lost 200 to a → nothing to pay
    const t = settle(
      balancesWithOpenDebts(
        [
          { playerId: "a", amount: 200 },
          { playerId: "b", amount: -200 },
        ],
        [{ from: "a", to: "b", amount: 200 }],
      ),
    );
    expect(t).toEqual([]);
  });

  it("matches the brute-force minimum on 300 random games", () => {
    const rand = rng(42);
    for (let round = 0; round < 300; round++) {
      const n = 2 + Math.floor(rand() * 8);
      const values = Array.from({ length: n - 1 }, () => Math.round((rand() - 0.5) * 20) * 50 || 0);
      values.push(-values.reduce((a, b) => a + b, 0) || 0);
      const balances = values.map((amount, i) => ({ playerId: `p${i}`, amount }));
      const nonZero = values.filter((v) => v !== 0);
      const t = expectSettles(balances);
      expect(t.length).toBe(nonZero.length === 0 ? 0 : nonZero.length - maxGroups(nonZero));
    }
  });

  it("handles 20 players quickly and more than 20 with the greedy fallback", () => {
    for (const n of [20, 30]) {
      const values = Array.from({ length: n }, (_, i) => (i % 2 ? -1 : 1) * (i + 1) * 10);
      values.push(-values.reduce((a, b) => a + b, 0) || 0);
      const t = expectSettles(values.map((amount, i) => ({ playerId: `p${i}`, amount })));
      expect(t.length).toBeLessThanOrEqual(values.length - 1);
    }
  });
});
