import { describe, expect, it } from "vitest";
import { BILLING_CASES, type SubscriptionState, planForSubscriptions, proEndsAt, subscriptionGivesPro } from "../src/billing";

describe("subscription → plan", () => {
  it.each(BILLING_CASES)("$name", (c) => {
    expect(subscriptionGivesPro(c.sub, c.at)).toBe(c.pro);
  });

  it("any subscription that gives Pro makes the user Pro", () => {
    const at = new Date("2026-06-01T00:00:00Z");
    const off: SubscriptionState = { status: "past_due", currentPeriodEnd: null, cancelAt: null };
    const on: SubscriptionState = { status: "active", currentPeriodEnd: null, cancelAt: null };
    expect(planForSubscriptions([], at)).toBe("free");
    expect(planForSubscriptions([off], at)).toBe("free");
    expect(planForSubscriptions([off, on], at)).toBe("pro");
  });

  it("tells when Pro stops", () => {
    const end = new Date("2026-07-01T00:00:00Z");
    expect(proEndsAt({ status: "active", currentPeriodEnd: end, cancelAt: null })).toBeNull();
    expect(proEndsAt({ status: "active", currentPeriodEnd: end, cancelAt: end })).toEqual(end);
    expect(proEndsAt({ status: "canceled", currentPeriodEnd: end, cancelAt: null })).toEqual(end);
  });
});
