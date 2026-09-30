import { describe, expect, it } from "vitest";
import { payerIndex } from "../src/payer";

const d = (day: number) => new Date(Date.UTC(2026, 8, day, 22));

describe("good-payer index", () => {
  it("averages days from close to paid, fastest first", () => {
    const r = payerIndex(
      [
        { playerId: "a", name: "Ali", closedAt: d(1), paidAt: d(3) },
        { playerId: "a", name: "Ali", closedAt: d(10), paidAt: d(11) },
        { playerId: "b", name: "Reza", closedAt: d(1), paidAt: d(1) },
        { playerId: "c", name: "Hadi", closedAt: d(1), paidAt: new Date(d(1).getTime() + 36 * 3600e3) },
      ],
      [
        { playerId: "a", name: "Ali" },
        { playerId: "d", name: "Abol" },
      ],
    );
    expect(r.map((x) => [x.name, x.averageDays, x.debts, x.open])).toEqual([
      ["Reza", 0, 1, 0],
      ["Hadi", 1.5, 1, 0],
      ["Ali", 1.5, 2, 1],
      ["Abol", null, 0, 1],
    ]);
  });

  it("a payment marked before the close counts as zero days", () => {
    expect(payerIndex([{ playerId: "a", name: "A", closedAt: d(2), paidAt: d(1) }])[0]!.averageDays).toBe(0);
  });

  it("is empty without debts", () => {
    expect(payerIndex([])).toEqual([]);
  });
});
