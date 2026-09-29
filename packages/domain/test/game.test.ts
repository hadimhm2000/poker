import { describe, expect, it } from "vitest";
import { closeBlockers, computeClose, deriveStatus, liveTotals } from "../src/game.js";

const rules = { requireConfirmation: false };

describe("closing a game", () => {
  it("needs at least two players", () => {
    const b = closeBlockers([{ playerId: "a", totalIn: 100, cashOut: 100 }], rules);
    expect(b.map((x) => x.code)).toEqual(["MIN_PLAYERS"]);
  });

  it("reports missing buy-ins, missing cash-outs and the imbalance with names", () => {
    const b = closeBlockers(
      [
        { playerId: "a", totalIn: 0, cashOut: 0 },
        { playerId: "b", totalIn: 200, cashOut: null },
        { playerId: "c", totalIn: 200, cashOut: 150 },
      ],
      rules,
    );
    expect(b).toEqual([
      { code: "NO_BUY_IN", playerIds: ["a"] },
      { code: "MISSING_CASH_OUT", playerIds: ["b"] },
      { code: "UNBALANCED", totalIn: 400, totalOut: 150, difference: -250 },
    ]);
  });

  it("a player who lost everything has cash-out 0, not missing", () => {
    const b = closeBlockers(
      [
        { playerId: "a", totalIn: 200, cashOut: 0 },
        { playerId: "b", totalIn: 200, cashOut: 400 },
      ],
      rules,
    );
    expect(b).toEqual([]);
  });

  it("requires confirmation only from players with accounts when the home asks for it", () => {
    const entries = [
      { playerId: "a", totalIn: 100, cashOut: 50, hasAccount: true, confirmed: true },
      { playerId: "b", totalIn: 100, cashOut: 150, hasAccount: true, confirmed: false },
      { playerId: "c", totalIn: 100, cashOut: 100, hasAccount: false },
    ];
    expect(closeBlockers(entries, rules)).toEqual([]);
    expect(closeBlockers(entries, { requireConfirmation: true })).toEqual([
      { code: "UNCONFIRMED", playerIds: ["b"] },
    ]);
  });

  it("balanced live games show as balanced and go back to live when a number changes", () => {
    const entries = [
      { playerId: "a", totalIn: 100, cashOut: 50 },
      { playerId: "b", totalIn: 100, cashOut: 150 },
    ];
    expect(deriveStatus("live", entries, rules)).toBe("balanced");
    entries[0]!.cashOut = 60;
    expect(deriveStatus("live", entries, rules)).toBe("live");
    expect(deriveStatus("closed", entries, rules)).toBe("closed");
  });

  it("computes live totals", () => {
    expect(
      liveTotals([
        { playerId: "a", totalIn: 300, cashOut: null },
        { playerId: "b", totalIn: 200, cashOut: 250 },
      ]),
    ).toEqual({ pot: 500, cashedOut: 250, difference: -250 });
  });

  it("refuses to compute a close that is blocked", () => {
    expect(() => computeClose([{ playerId: "a", totalIn: 1, cashOut: 1 }], rules)).toThrow(/MIN_PLAYERS/);
  });

  it("produces net results and minimal transfers", () => {
    const r = computeClose(
      [
        { playerId: "a", totalIn: 500, cashOut: 0 },
        { playerId: "b", totalIn: 500, cashOut: 800 },
        { playerId: "c", totalIn: 500, cashOut: 700 },
      ],
      rules,
    );
    expect(r.net).toEqual([
      { playerId: "a", amount: -500 },
      { playerId: "b", amount: 300 },
      { playerId: "c", amount: 200 },
    ]);
    expect(r.transfers).toEqual([
      { from: "a", to: "b", amount: 300 },
      { from: "a", to: "c", amount: 200 },
    ]);
  });
});
