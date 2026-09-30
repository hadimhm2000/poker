import { describe, expect, it } from "vitest";
import { latinize, normalizeSpeech, parseVoiceRebuy, voiceAmountToMoney } from "../src/voice";

const players = [
  { id: "ali", name: "علی" },
  { id: "reza", name: "رضا" },
  { id: "hadi", name: "Hadi" },
  { id: "abol", name: "Abolfazl" },
  { id: "marc", name: "Marc" },
  { id: "luca", name: "Luca" },
  { id: "juan", name: "Juan" },
  { id: "ivan", name: "Иван" },
  { id: "sara", name: "Sara Rossi" },
];

const ok = (text: string, ps = players) => {
  const r = parseVoiceRebuy(text, ps);
  if (!r.ok) throw new Error(`${text}: ${r.reason}`);
  return r;
};

describe("normalizing speech", () => {
  it("turns Persian and Arabic digits and separators into plain numbers", () => {
    expect(normalizeSpeech("۱٬۲۰۰ و ٣٠٠ و ۱٫۵")).toBe("1200 و 300 و 1.5");
    expect(normalizeSpeech("1,000 or 2,5")).toBe("1000 or 2.5");
  });
  it("treats ری‌بای with and without the zero-width joiner the same", () => {
    expect(normalizeSpeech("ری‌بای")).toBe(normalizeSpeech("ریبای"));
    expect(normalizeSpeech("ريباي")).toBe("ریبای");
  });
  it("gives names in three scripts a comparable Latin spelling", () => {
    expect(latinize(normalizeSpeech("Ali"))).toBe("ali");
    expect(latinize(normalizeSpeech("علی"))).toBe("li");
    expect(latinize(normalizeSpeech("Али"))).toBe("ali");
  });
});

describe("rebuy sentences in seven languages", () => {
  it("fa: «علی ۲۰۰ ری‌بای»", () => {
    expect(ok("علی ۲۰۰ ری‌بای")).toMatchObject({ playerId: "ali", amount: { value: 200, absolute: false } });
  });
  it("fa: number words with و", () => {
    expect(ok("رضا دویست و پنجاه ریبای").amount).toEqual({ value: 250, absolute: false });
    expect(ok("ری بای برای رضا سیصد").amount).toEqual({ value: 300, absolute: false });
  });
  it("fa: هزار and میلیون give the size in money", () => {
    expect(ok("ری‌بای ۱۰۰ هزار برای هادی")).toMatchObject({ playerId: "hadi", amount: { value: 100_000, absolute: true } });
    expect(ok("علی ۱٫۵ میلیون ری‌بای").amount).toEqual({ value: 1_500_000, absolute: true });
    expect(ok("علی دویست هزار تومن شارژ").amount).toEqual({ value: 200_000, absolute: true });
  });
  it("fa: «یک ری‌بای» counts one rebuy, not an amount of 1", () => {
    expect(ok("علی یک ری‌بای").amount).toBeNull();
    expect(ok("رضا یه ری بای میخواد").amount).toBeNull();
  });
  it("en: a Latin name matches a Persian player and the other way round", () => {
    expect(ok("Ali 200 rebuy")).toMatchObject({ playerId: "ali", amount: { value: 200, absolute: false } });
    expect(ok("هادی ری‌بای")).toMatchObject({ playerId: "hadi", amount: null });
    expect(ok("rebuy for Reza please").playerId).toBe("reza");
  });
  it("en: 200k, two hundred fifty, one thousand", () => {
    expect(ok("200k rebuy Ali").amount).toEqual({ value: 200_000, absolute: true });
    expect(ok("Hadi re-buy two hundred fifty").amount).toEqual({ value: 250, absolute: false });
    expect(ok("top up Hadi one thousand").amount).toEqual({ value: 1000, absolute: true });
  });
  it("en: speech-to-text spelling mistakes in names", () => {
    expect(ok("Abolfazel rebuy 50").playerId).toBe("abol");
    expect(ok("Hadie rebuy").playerId).toBe("hadi");
  });
  it("ar: Arabic spelling and the ل prefix", () => {
    expect(ok("ريباي لعلي ٣٠٠")).toMatchObject({ playerId: "ali", amount: { value: 300, absolute: false } });
    expect(ok("إعادة شراء لرضا خمسين ألف")).toMatchObject({ playerId: "reza", amount: { value: 50_000, absolute: true } });
  });
  it("fr, it, es", () => {
    expect(ok("recave de 50 pour Marc")).toMatchObject({ playerId: "marc", amount: { value: 50, absolute: false } });
    expect(ok("Luca ricarica cento")).toMatchObject({ playerId: "luca", amount: { value: 100, absolute: false } });
    expect(ok("recompra de doscientos para Juan")).toMatchObject({ playerId: "juan", amount: { value: 200, absolute: false } });
    expect(ok("rachat Marc deux cents").amount).toEqual({ value: 200, absolute: false });
  });
  it("ru: declined names and number words", () => {
    expect(ok("Ивану ребай двести")).toMatchObject({ playerId: "ivan", amount: { value: 200, absolute: false } });
    expect(ok("докупка Иван 5 тысяч").amount).toEqual({ value: 5000, absolute: true });
  });
  it("a two-word name matches by its first name", () => {
    expect(ok("Sara rebuy 100").playerId).toBe("sara");
    expect(ok("Sara Rossi rebuy").playerId).toBe("sara");
  });
});

describe("what is not understood is said so", () => {
  it("no rebuy word: ignored", () => {
    expect(parseVoiceRebuy("علی ۲۰۰", players)).toEqual({ ok: false, reason: "no_keyword" });
    expect(parseVoiceRebuy("see you all on Friday", players)).toEqual({ ok: false, reason: "no_keyword" });
  });
  it("unknown name", () => {
    expect(parseVoiceRebuy("Bob rebuy 200", players)).toMatchObject({ ok: false, reason: "no_player" });
    expect(parseVoiceRebuy("rebuy 200", players)).toMatchObject({ ok: false, reason: "no_player" });
  });
  it("two players in one sentence, or two similar names", () => {
    expect(parseVoiceRebuy("Ali and Reza rebuy", players)).toMatchObject({ ok: false, reason: "ambiguous" });
    const twins = [
      { id: "1", name: "Ali" },
      { id: "2", name: "Ala" },
    ];
    expect(parseVoiceRebuy("Alo rebuy", twins)).toMatchObject({ ok: false, reason: "ambiguous" });
  });
  it("short names do not match unrelated words", () => {
    expect(parseVoiceRebuy("rebuy for Bill", [{ id: "1", name: "Ali" }])).toMatchObject({ ok: false, reason: "no_player" });
  });
});

describe("amount in money", () => {
  it("a bare number is in display units, a spoken size is absolute", () => {
    expect(voiceAmountToMoney({ value: 200, absolute: false }, 1000)).toBe(200_000);
    expect(voiceAmountToMoney({ value: 200_000, absolute: true }, 1000)).toBe(200_000);
    expect(voiceAmountToMoney({ value: 1.5, absolute: false }, 1)).toBe(2);
    expect(voiceAmountToMoney({ value: 0.0001, absolute: false }, 1)).toBeNull();
  });
});
