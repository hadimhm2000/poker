import { describe, expect, it } from "vitest";
import { normalizeDigits, parseAmount, toInputValue } from "./format";

describe("typing amounts", () => {
  it("parses plain, Persian-digit and separator forms", () => {
    expect(parseAmount("200", 1)).toBe(200);
    expect(parseAmount("۲۰۰", 1000)).toBe(200000);
    expect(parseAmount("200,000", 1)).toBe(200000);
    expect(parseAmount("200٬000", 1)).toBe(200000);
    expect(parseAmount(" 1٬500٬000 ", 1)).toBe(1500000);
  });

  it("reads a dot between 3-digit groups as a thousands separator (Iranian habit)", () => {
    expect(parseAmount("200.000", 1)).toBe(200000);
    expect(parseAmount("1.500.000", 1)).toBe(1500000);
    expect(parseAmount("۱.۲۵۰.۰۰۰", 1)).toBe(1250000);
    // A real decimal point survives.
    expect(parseAmount("2.5", 1000)).toBe(2500);
    expect(parseAmount("2.5", 1)).toBe(3);
  });

  it("rejects garbage", () => {
    expect(parseAmount("", 1)).toBeNull();
    expect(parseAmount("abc", 1)).toBeNull();
    expect(parseAmount("12..5", 1)).toBeNull();
    expect(parseAmount("-5", 1)).toBeNull();
  });

  it("normalizeDigits only merges 3-digit groups, not other decimals", () => {
    expect(normalizeDigits("2.50")).toBe("2.50");
    expect(normalizeDigits("20.5")).toBe("20.5");
    expect(normalizeDigits("1.234")).toBe("1234");
  });

  it("round-trips an input value", () => {
    expect(toInputValue(200000, 1000)).toBe("200");
    expect(parseAmount(toInputValue(250000, 1000)!, 1000)).toBe(250000);
  });
});
