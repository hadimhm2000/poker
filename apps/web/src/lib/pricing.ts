// Prices shown on the pricing page (plan: "Plans": Pro $3.99 a month or $29 a year as a
// starting point). Display only: what is charged is the Paddle price behind
// PADDLE_PRICE_MONTHLY / PADDLE_PRICE_YEARLY, which Paddle may localize and tax.

const cents = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

export function pricing() {
  const currency = /^[A-Z]{3}$/.test(process.env.PRICING_CURRENCY ?? "") ? process.env.PRICING_CURRENCY! : "USD";
  const trial = Number(process.env.PRO_TRIAL_DAYS);
  return {
    monthlyCents: cents(process.env.PRICING_MONTHLY_CENTS, 399),
    yearlyCents: cents(process.env.PRICING_YEARLY_CENTS, 2900),
    currency,
    trialDays: Number.isSafeInteger(trial) && trial > 0 && trial <= 90 ? trial : null,
  };
}

/** Money in the smallest unit → "$3.99" in the reader's language (no decimals when whole). */
export function formatPrice(amountCents: number, currency: string, locale: string): string {
  const whole = amountCents % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
}
