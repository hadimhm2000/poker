// Subscription status → plan (plan: "Plans"; phase 5). The database applies the same rules in
// app.subscription_gives_pro() (0006_billing.sql); both are tested with BILLING_CASES.

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";

export interface SubscriptionState {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
}

/**
 * active / trialing: Pro, unless a scheduled cancel has already taken effect.
 * canceled: Pro until the paid period ends. past_due / paused: Free (nothing is deleted).
 */
export function subscriptionGivesPro(s: SubscriptionState, at: Date): boolean {
  switch (s.status) {
    case "active":
    case "trialing":
      return s.cancelAt === null || s.cancelAt > at;
    case "canceled":
      return s.currentPeriodEnd !== null && s.currentPeriodEnd > at;
    default:
      return false;
  }
}

export function planForSubscriptions(subs: readonly SubscriptionState[], at: Date): "free" | "pro" {
  return subs.some((s) => subscriptionGivesPro(s, at)) ? "pro" : "free";
}

/** When Pro stops without a renewal (a scheduled or done cancel), or null when it renews. */
export function proEndsAt(s: SubscriptionState): Date | null {
  if (s.status === "canceled") return s.currentPeriodEnd;
  return s.cancelAt;
}

const at = new Date("2026-06-01T12:00:00Z");
const before = new Date("2026-05-20T00:00:00Z");
const after = new Date("2026-06-20T00:00:00Z");

/** Shared by the domain test and the database test of app.subscription_gives_pro(). */
export const BILLING_CASES: { name: string; sub: SubscriptionState; at: Date; pro: boolean }[] = [
  { name: "active renews", sub: { status: "active", currentPeriodEnd: after, cancelAt: null }, at, pro: true },
  { name: "active without a period yet", sub: { status: "active", currentPeriodEnd: null, cancelAt: null }, at, pro: true },
  { name: "trialing", sub: { status: "trialing", currentPeriodEnd: after, cancelAt: null }, at, pro: true },
  { name: "cancel scheduled for later: still Pro", sub: { status: "active", currentPeriodEnd: after, cancelAt: after }, at, pro: true },
  { name: "scheduled cancel passed, webhook late: Free", sub: { status: "active", currentPeriodEnd: before, cancelAt: before }, at, pro: false },
  { name: "canceled, paid period still running", sub: { status: "canceled", currentPeriodEnd: after, cancelAt: at }, at, pro: true },
  { name: "canceled, period over", sub: { status: "canceled", currentPeriodEnd: before, cancelAt: before }, at, pro: false },
  { name: "canceled, no period known", sub: { status: "canceled", currentPeriodEnd: null, cancelAt: null }, at, pro: false },
  { name: "past due", sub: { status: "past_due", currentPeriodEnd: after, cancelAt: null }, at, pro: false },
  { name: "paused", sub: { status: "paused", currentPeriodEnd: null, cancelAt: null }, at, pro: false },
];
