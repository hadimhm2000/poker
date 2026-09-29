import { formatMoney } from "@poker/domain";
import { defaultCalendar } from "@/i18n/routing";

export interface HomeMoney {
  currency: string | null;
  unitSuffix: string;
  unitDivisor: number;
}

/** Amounts are typed in display units (e.g. "200" in a "k" home means 200,000). */
export function formatAmount(amount: number, home: HomeMoney, locale: string, signed = false): string {
  return formatMoney(amount, {
    locale,
    currency: home.unitSuffix ? null : home.currency,
    divisor: home.unitDivisor,
    suffix: home.unitSuffix || undefined,
    signed,
  });
}

/** Accepts Persian and Arabic-Indic digits and common thousands separators. */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[,\s٬،']/g, "")
    .replace(/٫/g, ".");
}

/** Parse a typed amount into the stored integer, or null when it is not a valid amount. */
export function parseAmount(input: string, divisor: number): number | null {
  const s = normalizeDigits(input.trim());
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const value = Math.round(Number(s) * divisor);
  return Number.isSafeInteger(value) ? value : null;
}

export function toInputValue(amount: number | null, divisor: number): string {
  return amount === null ? "" : String(amount / divisor);
}

export function formatDate(date: Date, locale: string, withTime = false): string {
  return new Intl.DateTimeFormat(`${locale}-u-ca-${defaultCalendar(locale)}`, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
  }).format(date);
}
