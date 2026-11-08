import { type ResultCardData, type Tx, resultCard } from "@poker/db";
import { sum } from "@poker/domain";
import { dir } from "@/i18n/routing";
import { botLocale, textsFor } from "@/telegram/i18n";
import { type CardFormat, type CardInput, renderCard } from "./card-image";
import { formatAmount, formatDate } from "./format";

/** The public page the card's QR opens. */
export const verifyUrl = (appUrl: string, locale: string, hash: string) => `${appUrl}/${botLocale(locale)}/verify/${hash}`;

/** Card texts in the home's language (plan: outputs use the home's language). */
export function cardInput(d: ResultCardData, appUrl: string, language?: string): CardInput {
  // The language the person is using right now wins over the home's default, like the
  // Excel and PDF exports: the picture reads the same as the screen it was made from.
  const locale = botLocale(language ?? d.locale);
  const t = textsFor(locale, "card");
  const num = new Intl.NumberFormat(locale);
  return {
    rtl: dir(locale) === "rtl",
    brand: t("brand"),
    homeName: d.homeName,
    title: t("title", { number: num.format(d.number) }),
    date: formatDate(d.closedAt, locale),
    potLabel: t("pot"),
    pot: formatAmount(sum(d.rows.map((r) => r.totalIn)), d, locale),
    rows: d.rows.map((r) => ({
      name: r.name,
      amount: formatAmount(r.net, d, locale, true),
      sign: Math.sign(r.net) as -1 | 0 | 1,
      value: r.net,
    })),
    playersLabel: t("players"),
    players: num.format(d.rows.length),
    winnerLabel: t("winner"),
    moreLabel: (n) => t("more", { count: n }),
    verifyLabel: t("scanToVerify"),
    verifyUrl: verifyUrl(appUrl, locale, d.hash),
    hashShort: d.hash.slice(0, 16),
  };
}

export async function resultCardPng(tx: Tx, gameId: string, appUrl: string, format: CardFormat = "post", language?: string) {
  const d = await resultCard(tx, gameId);
  return { png: renderCard(cardInput(d, appUrl, language), format), number: d.number, homeName: d.homeName };
}
