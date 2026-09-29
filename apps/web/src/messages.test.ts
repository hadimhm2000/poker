import { describe, expect, it } from "vitest";
import { locales } from "./i18n/routing";

type Tree = { [k: string]: string | Tree };
const flatten = (t: Tree, prefix = ""): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => {
    if (typeof v === "string") acc[prefix + k] = v;
    else Object.assign(acc, flatten(v, `${prefix}${k}.`));
    return acc;
  }, {});
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translations", async () => {
  const en = flatten((await import("../messages/en.json")).default as Tree);
  for (const locale of locales) {
    it(`${locale} has every key with the same placeholders`, async () => {
      const m = flatten((await import(`../messages/${locale}.json`)).default as Tree);
      expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en)) {
        expect(placeholders(m[key]!), `${locale}:${key}`).toEqual(placeholders(en[key]!));
        expect(m[key]!.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    });
  }
});
