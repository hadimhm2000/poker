import { describe, expect, it } from "vitest";
import { badges, monthOf, rowsInPeriod } from "../src/badges";
import type { ResultRow } from "../src/stats";

function game(number: number, results: Record<string, number>): ResultRow[] {
  return Object.entries(results).map(([name, n]) => ({
    gameId: `g${number}`,
    number,
    closedAt: new Date(Date.UTC(2026, 0, number)),
    playerId: `p-${name}`,
    name,
    totalIn: 500,
    cashOut: 500 + n,
  }));
}

describe("badges", () => {
  // ali wins 3 in a row (games 2-4), sara plays all 6 and comes back from -600, reza misses game 3.
  const rows = [
    ...game(1, { ali: -100, sara: -300, reza: 400 }),
    ...game(2, { ali: 200, sara: -300, reza: 100 }),
    ...game(3, { ali: 150, sara: -150 }),
    ...game(4, { ali: 50, sara: 300, reza: -350 }),
    ...game(5, { ali: -500, sara: 900, reza: -400 }),
    ...game(6, { ali: 0, sara: 100, reza: -100 }),
  ];
  const got = badges(rows);
  const of = (kind: string) => got.filter((b) => b.kind === kind).map((b) => [b.name, b.value, b.gameNumber]);

  it("win streak of three or more", () => {
    expect(of("streak")).toEqual([
      ["ali", 3, 4],
      ["sara", 3, 6],
    ]);
  });

  it("the single biggest win, one holder", () => {
    expect(of("bigWin")).toEqual([["sara", 900, 5]]);
  });

  it("played five or more home games in a row", () => {
    expect(of("regular")).toEqual([
      ["ali", 6, 6],
      ["sara", 6, 6],
    ]);
  });

  it("comeback: below zero at some point, above zero now", () => {
    // sara: -300, -600, -750 (low), -450, +450, +550 → recovered 1300.
    expect(of("comeback")).toEqual([["sara", 1300, undefined]]);
    // ali ends at -200: no comeback. reza never went... ends at -350: none.
  });

  it("nothing from nothing", () => {
    expect(badges([])).toEqual([]);
  });
});

describe("seasons", () => {
  it("a Gregorian month", () => {
    const m = monthOf(new Date(Date.UTC(2026, 1, 14)));
    expect(m.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(m.end!.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("a Solar Hijri month (Mehr 1405 starts 23 September 2026)", () => {
    const m = monthOf(new Date(Date.UTC(2026, 8, 30)), "persian");
    expect(m.start.toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(m.end!.toISOString()).toBe("2026-10-23T00:00:00.000Z");
  });

  it("filters rows to the period, end exclusive", () => {
    const rows = [...game(1, { a: 1, b: -1 }), ...game(2, { a: 1, b: -1 }), ...game(3, { a: 1, b: -1 })];
    const p = { start: new Date(Date.UTC(2026, 0, 2)), end: new Date(Date.UTC(2026, 0, 3)) };
    expect(new Set(rowsInPeriod(rows, p).map((r) => r.number))).toEqual(new Set([2]));
    expect(rowsInPeriod(rows, { start: p.start, end: null })).toHaveLength(4);
  });
});
