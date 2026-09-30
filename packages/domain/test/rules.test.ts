import { describe, expect, it } from "vitest";
import { parseCards } from "../src/cards";
import { evaluate5 } from "../src/hand";
import { HAND_EXAMPLES, SITUATIONS, exampleWinners, potLimitMax, searchRules } from "../src/rules";

describe("rules section", () => {
  it("every card example matches the hand engine", () => {
    const withExamples = SITUATIONS.filter((s) => s.example);
    expect(withExamples.length).toBeGreaterThanOrEqual(11);
    for (const s of withExamples) expect(exampleWinners(s.example!), s.id).toEqual(s.example!.winners);
  });

  it("hand ranking examples are in their category, strongest first", () => {
    const values = HAND_EXAMPLES.map((h) => evaluate5(parseCards(h.cards)));
    values.forEach((v, i) => expect(v.key).toBe(HAND_EXAMPLES[i]!.key));
    for (let i = 1; i < values.length; i++) expect(values[i - 1]!.score).toBeGreaterThan(values[i]!.score);
  });

  it("ids are unique", () => {
    expect(new Set(SITUATIONS.map((s) => s.id)).size).toBe(SITUATIONS.length);
  });

  it("search matches tags in English and the translated text in any language", () => {
    const text = (id: string) => (id === "kicker" ? "کیکر: فقط ۵ کارت حساب می‌شود" : "");
    expect(searchRules("omaha flush", text)[0]).toBe("omahaFlush");
    expect(searchRules("کیکر", text)).toEqual(["kicker"]);
    expect(searchRules("OMAHA", text)).toContain("omahaStraight");
    expect(searchRules("nothing like this", text)).toEqual([]);
    expect(searchRules("  ", text)).toEqual([]);
  });

  it("pot-limit maximum: pot 100, a bet of 50, you may raise to 250", () => {
    // 100 in the middle + 50 bet = 150; call 50 makes 200; raise by 200 → to 250.
    expect(potLimitMax({ pot: 150, currentBet: 50, alreadyIn: 0 })).toEqual({ toCall: 50, raiseTo: 250, putIn: 250 });
    // Big blind 2 already in, pot 3 (1+2), bet 2 to call from the small blind 1.
    expect(potLimitMax({ pot: 3, currentBet: 2, alreadyIn: 1 })).toEqual({ toCall: 1, raiseTo: 6, putIn: 5 });
    expect(potLimitMax({ pot: 40, currentBet: 0, alreadyIn: 0 })).toEqual({ toCall: 0, raiseTo: 40, putIn: 40 });
    expect(() => potLimitMax({ pot: 10, currentBet: 1, alreadyIn: 2 })).toThrow();
    expect(() => potLimitMax({ pot: 1.5, currentBet: 0, alreadyIn: 0 })).toThrow();
  });
});
