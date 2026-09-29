import { defineRouting } from "next-intl/routing";

export const locales = ["fa", "en", "ar", "fr", "it", "ru", "es"] as const;
export type Locale = (typeof locales)[number];
export const rtlLocales: readonly Locale[] = ["fa", "ar"];

export const routing = defineRouting({
  locales,
  defaultLocale: "en",
  localePrefix: "always",
});

export const dir = (locale: string) => (rtlLocales.includes(locale as Locale) ? "rtl" : "ltr");

export const localeNames: Record<Locale, string> = {
  fa: "فارسی",
  en: "English",
  ar: "العربية",
  fr: "Français",
  it: "Italiano",
  ru: "Русский",
  es: "Español",
};

/** Persian uses the Solar Hijri calendar by default; everyone else Gregorian. */
export const defaultCalendar = (locale: string) => (locale === "fa" ? "persian" : "gregory");
