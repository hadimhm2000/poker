import { createTranslator } from "next-intl";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import fa from "../../messages/fa.json";
import fr from "../../messages/fr.json";
import it from "../../messages/it.json";
import ru from "../../messages/ru.json";
import { type Locale, locales } from "@/i18n/routing";

const all = { ar, en, es, fa, fr, it, ru } as const;

export const botLocale = (v: string | null | undefined): Locale =>
  locales.includes(v as Locale) ? (v as Locale) : "en";

/** Bot texts in the given language (the home's language in groups, the user's in private). */
export function botT(locale: string) {
  const l = botLocale(locale);
  return createTranslator({ locale: l, messages: all[l] as typeof en, namespace: "bot" });
}
export type BotT = ReturnType<typeof botT>;

/** Telegram HTML parse mode: escape user-provided text. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
