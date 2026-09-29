/**
 * All money is an integer count of the currency's smallest unit (e.g. 1 toman, 1 cent).
 * Never floats. The database stores these as bigint; in TypeScript we keep them as
 * safe integers and refuse anything else.
 */
export type Money = number;

export class MoneyError extends Error {}

export function assertMoney(value: unknown, field = "amount"): asserts value is Money {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${field} must be a safe integer (smallest currency unit)`);
  }
}

export function assertNonNegative(value: unknown, field = "amount"): asserts value is Money {
  assertMoney(value, field);
  if ((value as number) < 0) throw new MoneyError(`${field} must be >= 0`);
}

export function sum(values: readonly Money[]): Money {
  let total = 0;
  for (const v of values) {
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError("sum overflow");
  }
  return total;
}

export interface MoneyFormat {
  locale: string;
  /** ISO 4217 code, or null when the home uses a free-form unit only. */
  currency: string | null;
  /** Divisor applied before display: 1000 with suffix "k" shows 2980000 as "2,980k". */
  divisor?: number;
  suffix?: string;
  signed?: boolean;
}

export function formatMoney(amount: Money, fmt: MoneyFormat): string {
  const divisor = fmt.divisor ?? 1;
  const value = amount / divisor;
  const opts: Intl.NumberFormatOptions = { maximumFractionDigits: divisor === 1 ? 0 : 1 };
  if (fmt.signed) opts.signDisplay = "exceptZero";
  if (fmt.currency && !fmt.suffix) {
    opts.style = "currency";
    opts.currency = fmt.currency;
  }
  const text = new Intl.NumberFormat(fmt.locale, opts).format(value);
  return fmt.suffix ? `${text}${fmt.suffix}` : text;
}
