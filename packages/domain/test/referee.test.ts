import { describe, expect, it } from "vitest";
import { judge, rulingAnchor } from "../src/referee";
import { SITUATIONS } from "../src/rules";

const hold = (board: string, ...hands: string[]) =>
  judge({ variant: "holdem", board, hands: hands.map((cards, i) => ({ label: `P${i + 1}`, cards })) });
const omaha = (board: string, ...hands: string[]) =>
  judge({ variant: "omaha", board, hands: hands.map((cards, i) => ({ label: `P${i + 1}`, cards })) });

describe("companion referee", () => {
  it("gives the winner, the best five cards and the reason", () => {
    const r = hold("Kh Kd 9c 9s 4d", "Qc 4h", "Ac 2h");
    expect(r.winners).toEqual(["P2"]);
    expect(r.decidedBy).toEqual({ kind: "tiebreak", index: 2 });
    expect(r.hands[1]).toMatchObject({ label: "P2", key: "twoPair", best: ["Kh", "Kd", "9c", "9s", "Ac"] });
    expect(r.situation).toBe("threePairs");
    expect(rulingAnchor(r.situation)).toBe("#s-threePairs");
  });

  it("finds the disputed situation from the rules table", () => {
    expect(hold("As Kd Qh Jc Ts", "2c 3d", "4h 5s").situation).toBe("boardPlays");
    expect(hold("Ah Ad Ac As 5h", "Kc 2d", "Qc 3d").situation).toBe("boardQuads");
    expect(hold("Ah Jh 8h 5h 3h", "2c 2d", "4c 4d").situation).toBe("suits");
    expect(hold("Ah Jh 8h 5d 3c", "Kh 2h", "Qh 4h").situation).toBe("twoFlushes");
    expect(hold("9h 9d 8c 2s Kd", "9c 2h", "8h 8d").situation).toBe("fullHouses");
    expect(hold("Ah 2d 3c 9s Kd", "4h 5s", "Qh Qs").situation).toBe("wheel");
    expect(hold("Ah Kd 7c 4s 2d", "As Qh", "Ac Jh").situation).toBe("kicker");
    expect(omaha("3h 7h 9h Jh 5c", "Ah Kc Qd 2s", "2h 4h 6c 8d").situation).toBe("omahaFlush");
    expect(omaha("5h 6d 7c 8s Kh", "9c Kd Qs Jh", "9d Tc 2c 3h").situation).toBe("omahaStraight");
    expect(omaha("Ah Ad Ac As 5h", "Kc Kd 2s 3h", "Qc Jd Ts 9h").situation).toBe("omahaQuads");
  });

  it("a plain category win points to the hand rankings", () => {
    const r = hold("Ah Kd 7c 4s 2d", "7h 7d", "As Qh");
    expect(r.decidedBy).toEqual({ kind: "category" });
    expect(r.situation).toBeNull();
    expect(rulingAnchor(r.situation)).toBe("#hands");
  });

  it("every situation it names exists on the rules page", () => {
    const ids = new Set(SITUATIONS.map((s) => s.id));
    for (const r of [hold("As Kd Qh Jc Ts", "2c 3d", "4h 5s"), hold("Ah Kd 7c 4s 2d", "As Qh", "Ac Jh")]) {
      expect(ids.has(r.situation!)).toBe(true);
    }
  });

  it("uses player names as labels", () => {
    const r = judge({
      variant: "holdem",
      board: "Kh Kd 9c 9s 4d",
      hands: [
        { label: "Ali", cards: "Qc 4h" },
        { label: "Reza", cards: "Ac 2h" },
      ],
    });
    expect(r.winners).toEqual(["Reza"]);
  });

  it("refuses incomplete or impossible input", () => {
    expect(() => hold("Kh Kd 9c 9s", "Qc 4h", "Ac 2h")).toThrow(/five/);
    expect(() => hold("Kh Kd 9c 9s 4d", "Qc 4h")).toThrow(/two to ten/);
    expect(() => hold("Kh Kd 9c 9s 4d", "Kh 4h", "Ac 2h")).toThrow(/duplicate/);
    expect(() => hold("Kh Kd 9c 9s 4d", "Qc", "Ac 2h")).toThrow(/2 cards/);
    expect(() => omaha("Kh Kd 9c 9s 4d", "Qc 4h", "Ac 2h")).toThrow(/omaha/);
    expect(() =>
      judge({
        variant: "holdem",
        board: "Kh Kd 9c 9s 4d",
        hands: [
          { label: "Ali", cards: "Qc 4h" },
          { label: "ali", cards: "Ac 2h" },
        ],
      }),
    ).toThrow(/labels/);
  });
});
