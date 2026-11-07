/**
 * Money unit words shared by the home's money-settings form and the server action:
 * how "تومان / ریال / دلار / یورو" plus a "هزار / میلیون" shorthand map onto the
 * home's stored columns (currency, unitSuffix, unitDivisor).
 *
 * The suffix is built in the viewing locale so the shorthand reads naturally:
 * fa/ar "هزار تومان", others "Toman k".
 */

const UNIT_WORDS: Record<string, Record<string, string>> = {
  toman: { fa: "تومان", ar: "تومان", en: "Toman", es: "Toman", fr: "Toman", it: "Toman", ru: "Томан" },
  rial: { fa: "ریال", ar: "ريال", en: "Rial", es: "Rial", fr: "Rial", it: "Rial", ru: "Риал" },
  usd: { fa: "دلار", ar: "دولار", en: "USD", es: "USD", fr: "USD", it: "USD", ru: "USD" },
  eur: { fa: "یورو", ar: "يورو", en: "EUR", es: "EUR", fr: "EUR", it: "EUR", ru: "EUR" },
};

const SCALE_WORDS: Record<string, Record<string, string>> = {
  "1000": { fa: "هزار", ar: "ألف", en: "k", es: "k", fr: "k", it: "k", ru: "тыс." },
  "1000000": { fa: "میلیون", ar: "مليون", en: "M", es: "M", fr: "M", it: "M", ru: "млн" },
};

export type MoneyUnit = "toman" | "rial" | "usd" | "eur" | "custom";
export type MoneyScale = 1 | 1000 | 1000000;

/** The full suffix for a unit+scale in a locale, e.g. ("toman", 1000, "fa") → "هزار تومان". */
export function moneyUnitWords(unit: MoneyUnit | string, scale: number, locale: string): string {
  const words = UNIT_WORDS[unit] ?? UNIT_WORDS.toman!;
  const unitWord = words[locale] ?? words.en!;
  const scaleWord = scale > 1 ? (SCALE_WORDS[String(scale)]?.[locale] ?? SCALE_WORDS[String(scale)]?.en) : null;
  if (!scaleWord) return unitWord;
  return locale === "fa" || locale === "ar" ? `${scaleWord} ${unitWord}` : `${unitWord} ${scaleWord}`;
}

/** How the money-settings form maps onto the home's stored columns. */
export function moneySettingsOf(unit: MoneyUnit | string, scale: number, custom: string, locale: string) {
  const suffix = unit === "custom" ? custom.trim() : moneyUnitWords(unit, scale, locale);
  return { currency: null, unitSuffix: suffix, unitDivisor: scale };
}

/**
 * Best-effort reverse mapping so the form opens with the home's current settings:
 * recognise "هزار تومان" style suffixes (any locale) and plain unit words.
 */
export function parseUnitChoice(suffix: string, divisor: number, locale: string): { unit: MoneyUnit; scale: MoneyScale } {
  const scale: MoneyScale = divisor === 1000000 ? 1000000 : divisor === 1000 ? 1000 : 1;
  const text = suffix.trim();
  for (const [unit, words] of Object.entries(UNIT_WORDS)) {
    for (const word of new Set([words[locale] ?? words.en!, words.en!])) {
      const withScale = moneyUnitWords(unit, scale, locale);
      if (text === withScale || text === word) return { unit: unit as MoneyUnit, scale };
    }
  }
  return { unit: "custom", scale };
}
