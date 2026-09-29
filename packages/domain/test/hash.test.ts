import { describe, expect, it } from "vitest";
import { GENESIS_HASH, type HashableGame, canonicalJson, gameHash, verifyChain } from "../src/hash.js";

const game = (n: number, out = 150): HashableGame => ({
  homeId: "h1",
  number: n,
  closedAt: "2026-09-29T22:00:00.000Z",
  currency: "IRR",
  entries: [
    { playerId: "b", totalIn: 100, cashOut: out },
    { playerId: "a", totalIn: 100, cashOut: 200 - out },
  ],
});

describe("hash chain", () => {
  it("canonical JSON sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] })).toBe('{"a":[2,{"c":null,"d":1}],"b":1}');
  });

  it("does not depend on entry order", async () => {
    const g = game(1);
    const reordered = { ...g, entries: [...g.entries].reverse() };
    expect(await gameHash(GENESIS_HASH, g)).toBe(await gameHash(GENESIS_HASH, reordered));
  });

  it("detects tampering with an old game", async () => {
    const links = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= 3; i++) {
      const g = game(i);
      const hash = await gameHash(prev, g);
      links.push({ game: g, prevHash: prev, hash });
      prev = hash;
    }
    expect(await verifyChain(links)).toBe(-1);
    links[1] = { ...links[1]!, game: game(2, 160) };
    expect(await verifyChain(links)).toBe(1);
  });
});
