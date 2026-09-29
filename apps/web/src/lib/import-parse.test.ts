import { describe, expect, it } from "vitest";
import { detectColumns, jalaliToGregorian, parseDate, parseMoney, parseSheet } from "./import-parse";

describe("dates", () => {
  it("converts Solar Hijri dates", () => {
    expect(jalaliToGregorian(1403, 1, 1)).toEqual([2024, 3, 20]);
    expect(jalaliToGregorian(1405, 7, 7)).toEqual([2026, 9, 29]);
    expect(parseDate("۱۴۰۳/۰۵/۱۲")).toBe("2024-08-02");
  });
  it("reads ISO, day-first, Excel serials and Date cells", () => {
    expect(parseDate("2025-03-14")).toBe("2025-03-14");
    expect(parseDate("14/03/2025")).toBe("2025-03-14");
    expect(parseDate(45730)).toBe("2025-03-14");
    expect(parseDate(new Date("2025-03-14T00:00:00Z"))).toBe("2025-03-14");
    expect(parseDate("hello")).toBeNull();
  });
});

describe("money", () => {
  it("reads display units with suffixes, separators and Persian digits", () => {
    expect(parseMoney("2,980k", 1000)).toBe(2_980_000);
    expect(parseMoney("-۵۰۰", 1000)).toBe(-500_000);
    expect(parseMoney("+1.5", 1000)).toBe(1500);
    expect(parseMoney(250, 1)).toBe(250);
    expect(parseMoney("abc", 1)).toBeNull();
  });
});

describe("columns", () => {
  it("finds Persian and English headers", () => {
    expect(detectColumns(["تاریخ", "شماره بازی", "بازیکن", "ورودی", "سود/زیان"])).toEqual({ date: 0, number: 1, player: 2, in: 3, net: 4 });
    expect(detectColumns(["Date", "Game", "Player", "Buy-in", "Cash-out"])).toEqual({ date: 0, number: 1, player: 2, in: 3, out: 4 });
  });
});

describe("parseSheet", () => {
  const table = [
    ["Poker nights"],
    ["Date", "#", "Player", "In", "Net"],
    ["2025-03-14", 1, "Abol", 500, 700],
    [null, null, "Sara", 700, -700],
    [null, null, "Reza", 300, 0],
    ["2025-03-21", 2, "Abol", 500, -100],
    [null, null, "Sara", 500, 50],
    ["2025-03-28", 3, "Abol", 500, 100],
    [null, null, "Sara", 500, -100],
    ["2025-04-04", 4, "Abol", 500, 100],
    [null, null, "Sara", 500, -100],
  ];

  it("groups by game number, fills merged date cells and checks balance", () => {
    const r = parseSheet(table, 1);
    expect(r.error).toBeNull();
    expect(r.games.map((g) => [g.number, g.date, g.rows.length, g.status])).toEqual([
      [1, "2025-03-14", 3, "ok"],
      [2, "2025-03-21", 2, "unbalanced"],
      [3, "2025-03-28", 2, "ok"],
      [4, "2025-04-04", 2, "ok"],
    ]);
    expect(r.games[0]!.rows[0]).toEqual({ name: "Abol", totalIn: 500, cashOut: 1200 });
    expect(r.games[1]!.difference).toBe(-50);
  });

  it("flags games that are already in the home", () => {
    const r = parseSheet(table, 1, [{ date: "2025-03-28", results: [{ name: "abol", net: 100 }, { name: "SARA", net: -100 }] }]);
    expect(r.games.find((g) => g.number === 3)!.status).toBe("duplicate");
  });

  it("flags the same game twice in the file", () => {
    const r = parseSheet(
      [["Date", "Player", "Net"], ["2025-01-01", "a", 5], ["2025-01-01", "b", -5], ["2025-01-02", "a", 5], ["2025-01-02", "b", -5]],
      1,
    );
    expect(r.games.map((g) => g.status)).toEqual(["ok", "ok"]);
    const dup = parseSheet([["Date", "#", "Player", "Net"], ["2025-01-01", 1, "a", 5], ["2025-01-01", 1, "b", -5], ["2025-01-01", 2, "a", 5], ["2025-01-01", 2, "b", -5]], 1);
    expect(dup.games.map((g) => g.status)).toEqual(["ok", "duplicateInFile"]);
  });

  it("net-only sheets become buy-in/cash-out pairs that balance", () => {
    const r = parseSheet([["Date", "Player", "Net"], ["2025-01-01", "a", 300], ["2025-01-01", "b", -200], ["2025-01-01", "c", -100]], 1);
    expect(r.games[0]!.rows).toEqual([
      { name: "a", totalIn: 0, cashOut: 300 },
      { name: "b", totalIn: 200, cashOut: 0 },
      { name: "c", totalIn: 100, cashOut: 0 },
    ]);
    expect(r.games[0]!.status).toBe("ok");
  });

  it("reports missing columns", () => {
    expect(parseSheet([["foo", "bar"], [1, 2]], 1).error).toBe("noColumns");
  });
});
