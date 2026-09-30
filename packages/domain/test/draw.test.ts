import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { drawCommit, drawKey, drawOrder, randomHex32, verifyDraw } from "../src/draw";

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const seed = hex("seed");
const players = ["p-c", "p-a", "p-b", "p-d"];

describe("fair draw", () => {
  it("the commit is SHA-256 of the seed bytes", async () => {
    expect(await drawCommit(seed)).toBe(createHash("sha256").update(Buffer.from(seed, "hex")).digest("hex"));
    await expect(drawCommit("xyz")).rejects.toThrow();
  });

  it("the key hashes the seed and the contributions ordered by player id", async () => {
    const a = hex("a");
    const b = hex("b");
    const key = await drawKey({
      seed,
      players,
      contributions: [
        { playerId: "p-b", value: b },
        { playerId: "p-a", value: a },
      ],
    });
    expect(key).toBe(createHash("sha256").update(Buffer.from(seed + a + b, "hex")).digest("hex"));
    // Order of submission does not matter.
    expect(
      await drawKey({
        seed,
        players,
        contributions: [
          { playerId: "p-a", value: a },
          { playerId: "p-b", value: b },
        ],
      }),
    ).toBe(key);
  });

  it("is deterministic and independent of the input order of players", async () => {
    const r1 = await drawOrder({ seed, players, contributions: [] });
    const r2 = await drawOrder({ seed, players: [...players].reverse(), contributions: [] });
    expect(r2.order).toEqual(r1.order);
    expect(r1.sorted).toEqual(["p-a", "p-b", "p-c", "p-d"]);
    expect([...r1.order].sort()).toEqual(r1.sorted);
    expect(r1.steps).toHaveLength(3);
    expect(r1.key).toBe(createHash("sha256").update(Buffer.from(seed, "hex")).digest("hex"));
    // Pinned so the algorithm can never change silently: published draws must stay verifiable.
    expect(r1.order).toMatchInlineSnapshot(`
      [
        "p-d",
        "p-a",
        "p-c",
        "p-b",
      ]
    `);
  });

  it("any contribution changes the result", async () => {
    const base = await drawOrder({ seed, players, contributions: [] });
    let changed = 0;
    for (let i = 0; i < 20; i++) {
      const r = await drawOrder({ seed, players, contributions: [{ playerId: "p-a", value: hex(`c${i}`) }] });
      if (r.order.join() !== base.order.join()) changed++;
    }
    expect(changed).toBeGreaterThan(10);
  });

  it("every seat order is about equally likely", async () => {
    const counts = new Map<string, number>();
    const n = 6000;
    for (let i = 0; i < n; i++) {
      const r = await drawOrder({ seed: hex(`u${i}`), players: ["a", "b", "c"], contributions: [] });
      counts.set(r.order.join(""), (counts.get(r.order.join("")) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const c of counts.values()) expect(Math.abs(c - n / 6)).toBeLessThan(150);
    // The first dealer (seat 1) is uniform among the players.
    const first = new Map<string, number>();
    for (const [order, c] of counts) first.set(order[0]!, (first.get(order[0]!) ?? 0) + c);
    for (const c of first.values()) expect(Math.abs(c - n / 3)).toBeLessThan(200);
  });

  it("detects a seed that does not match the commit", async () => {
    const commit = await drawCommit(seed);
    expect((await verifyDraw(commit, { seed, players, contributions: [] })).commitOk).toBe(true);
    expect((await verifyDraw(commit, { seed: hex("other"), players, contributions: [] })).commitOk).toBe(false);
  });

  it("refuses bad input", async () => {
    await expect(drawOrder({ seed, players, contributions: [{ playerId: "stranger", value: hex("x") }] })).rejects.toThrow(/outside/);
    await expect(drawOrder({ seed, players, contributions: [{ playerId: "p-a", value: "12" }] })).rejects.toThrow(/64 hex/);
    await expect(
      drawOrder({
        seed,
        players,
        contributions: [
          { playerId: "p-a", value: hex("1") },
          { playerId: "p-a", value: hex("2") },
        ],
      }),
    ).rejects.toThrow(/one contribution/);
    await expect(drawOrder({ seed, players: ["a", "a"], contributions: [] })).rejects.toThrow(/duplicate/);
  });

  it("makes fresh random values", () => {
    expect(randomHex32()).toMatch(/^[0-9a-f]{64}$/);
    expect(randomHex32()).not.toBe(randomHex32());
  });
});
