import { describe, expect, it } from "vitest";
import { fullDeck, parseCards } from "../src/cards";
import {
  CATEGORY_COMBINATIONS,
  type CategoryKey,
  HandCategory,
  bestHand,
  evaluate5,
  showdown,
} from "../src/hand";

const c = parseCards;
const holdem = (board: string, hands: Record<string, string>) =>
  showdown(
    "holdem",
    c(board),
    Object.entries(hands).map(([id, h]) => ({ id, hole: c(h) })),
  );
const omaha = (board: string, hands: Record<string, string>) =>
  showdown(
    "omaha",
    c(board),
    Object.entries(hands).map(([id, h]) => ({ id, hole: c(h) })),
  );

describe("rules table: disputed situations", () => {
  it("best five cards on the board: everyone splits", () => {
    const r = holdem("As Kd Qh Jc Ts", { a: "2c 3d", b: "4h 5s", c: "7c 8c" });
    expect(r.winners).toEqual(["a", "b", "c"]);
    expect(r.decidedBy.kind).toBe("tie");
  });

  it("kicker: only five cards count, board A-A-K-K-Q makes J and 10 tie", () => {
    const r = holdem("Ah Ad Kc Ks Qd", { j: "Jc 2d", t: "Tc 3d" });
    expect(r.winners).toEqual(["j", "t"]);
  });

  it("no suit beats another: two flushes of equal ranks split", () => {
    const r = holdem("Ah Jh 8h 5h 3h", { a: "2c 2d", b: "4c 4d" });
    expect(r.winners).toEqual(["a", "b"]);
    const spades = evaluate5(c("As Js 8s 5s 3s"));
    const hearts = evaluate5(c("Ah Jh 8h 5h 3h"));
    expect(spades.score).toBe(hearts.score);
  });

  it("three pairs: top two pairs plus best remaining card (K-K-9-9-4, Q-4 loses to A-2)", () => {
    const r = holdem("Kh Kd 9c 9s 4d", { q4: "Qc 4h", a2: "Ac 2h" });
    expect(r.winners).toEqual(["a2"]);
    expect(r.decidedBy).toEqual({ kind: "tiebreak", index: 2 });
  });

  it("two full houses: trips first, then the pair", () => {
    expect(evaluate5(c("9h 9d 9c 2s 2d")).score).toBeGreaterThan(evaluate5(c("8h 8d 8c As Ad")).score);
  });

  it("two flushes: compare highest card, then the next, down to the fifth", () => {
    const a = evaluate5(c("Ah Jh 8h 5h 3h"));
    const b = evaluate5(c("Ad Jd 8d 4d 3d"));
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("A-2-3-4-5 is the lowest straight and Q-K-A-2-3 is not a straight", () => {
    const wheel = evaluate5(c("Ah 2d 3c 4s 5h"));
    expect(wheel.category).toBe(HandCategory.Straight);
    expect(wheel.tiebreak).toEqual([5]);
    expect(wheel.score).toBeLessThan(evaluate5(c("2h 3d 4c 5s 6h")).score);
    expect(evaluate5(c("Qh Kd Ac 2s 3h")).category).toBe(HandCategory.HighCard);
  });

  it("omaha: four hearts on the board and one heart in hand is not a flush", () => {
    const one = bestHand("omaha", c("Ah Kc Qd 2s"), c("3h 7h 9h Jh 5c"));
    expect(one.category).not.toBe(HandCategory.Flush);
    const two = bestHand("omaha", c("Ah Kh Qd 2s"), c("3h 7h 9h Jh 5c"));
    expect(two.category).toBe(HandCategory.Flush);
  });

  it("omaha: four straight cards on the board and one 9 in hand is not a straight", () => {
    const v = bestHand("omaha", c("9c Kd 2s 2h"), c("5h 6d 7c 8s Kh"));
    expect(v.category).not.toBe(HandCategory.Straight);
    expect(bestHand("omaha", c("9c 4d 2s 3h"), c("5h 6d 7c 8s Kh")).category).toBe(HandCategory.Straight);
  });

  it("omaha: four aces on the board, nobody has quads; a pocket pair makes a full house", () => {
    const pair = bestHand("omaha", c("Kc Kd 2s 3h"), c("Ah Ad Ac As 5h"));
    expect(pair.category).toBe(HandCategory.FullHouse);
    expect(pair.tiebreak).toEqual([14, 13]);
    const noPair = bestHand("omaha", c("Kc Qd 2s 3h"), c("Ah Ad Ac As 5h"));
    expect(noPair.category).toBe(HandCategory.Trips);
  });

  it("hold'em: four aces on the board is quads for everyone, kicker decides", () => {
    const r = holdem("Ah Ad Ac As 5h", { k: "Kc 2d", q: "Qc 3d" });
    expect(r.winners).toEqual(["k"]);
  });

  it("royal flush is labelled", () => {
    expect(evaluate5(c("As Ks Qs Js Ts")).key).toBe("royalFlush");
  });

  it("rejects duplicate cards and malformed input", () => {
    expect(() => holdem("As Kd Qh Jc Ts", { a: "As 2d" })).toThrow(/duplicate/);
    expect(() => c("1x")).toThrow();
    expect(c("10h")[0]).toEqual({ rank: 10, suit: "h" });
  });
});

describe("category counts over all 2,598,960 five-card hands", () => {
  it("matches the textbook combinations", () => {
    const deck = fullDeck();
    const counts: Record<string, number> = {};
    const hand = new Array(5);
    for (let a = 0; a < 48; a++)
      for (let b = a + 1; b < 49; b++)
        for (let d = b + 1; d < 50; d++)
          for (let e = d + 1; e < 51; e++)
            for (let f = e + 1; f < 52; f++) {
              hand[0] = deck[a];
              hand[1] = deck[b];
              hand[2] = deck[d];
              hand[3] = deck[e];
              hand[4] = deck[f];
              const k = evaluate5(hand).key;
              counts[k] = (counts[k] ?? 0) + 1;
            }
    for (const [key, n] of Object.entries(CATEGORY_COMBINATIONS)) expect(counts[key as CategoryKey]).toBe(n);
  }, 60_000);
});
