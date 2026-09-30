import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkoutLocale, paddleHosts, parsePaddleEvent, portalUrl, verifyPaddleSignature } from "./paddle";

const SECRET = "pdl_ntfset_01test_secret";
const now = 1_790_000_000_000;
const ts = String(Math.floor(now / 1000));
const sign = (body: string, t = ts, secret = SECRET) => createHmac("sha256", secret).update(`${t}:${body}`).digest("hex");
const body = JSON.stringify({ event_id: "evt_1", event_type: "subscription.created" });

describe("Paddle-Signature", () => {
  it("accepts a correct, fresh signature", () => {
    expect(verifyPaddleSignature(`ts=${ts};h1=${sign(body)}`, body, SECRET, now)).toBe(true);
  });
  it("accepts any matching h1 during a secret rotation", () => {
    expect(verifyPaddleSignature(`ts=${ts};h1=${sign(body, ts, "old")};h1=${sign(body)}`, body, SECRET, now)).toBe(true);
  });
  it("rejects a changed body", () => {
    expect(verifyPaddleSignature(`ts=${ts};h1=${sign(body)}`, body.replace("evt_1", "evt_2"), SECRET, now)).toBe(false);
  });
  it("rejects the wrong secret", () => {
    expect(verifyPaddleSignature(`ts=${ts};h1=${sign(body, ts, "other")}`, body, SECRET, now)).toBe(false);
  });
  it("rejects a moved timestamp (the signature covers it)", () => {
    const later = String(Number(ts) + 10);
    expect(verifyPaddleSignature(`ts=${later};h1=${sign(body)}`, body, SECRET, now)).toBe(false);
  });
  it("rejects stale and future timestamps (more than 5 minutes)", () => {
    const old = String(Number(ts) - 301);
    expect(verifyPaddleSignature(`ts=${old};h1=${sign(body, old)}`, body, SECRET, now)).toBe(false);
    const future = String(Number(ts) + 301);
    expect(verifyPaddleSignature(`ts=${future};h1=${sign(body, future)}`, body, SECRET, now)).toBe(false);
    const recent = String(Number(ts) - 299);
    expect(verifyPaddleSignature(`ts=${recent};h1=${sign(body, recent)}`, body, SECRET, now)).toBe(true);
  });
  it("rejects missing or malformed headers and an empty secret", () => {
    for (const h of [null, "", `h1=${sign(body)}`, `ts=${ts}`, `ts=abc;h1=${sign(body)}`, `ts=${ts};h1=zz`, `ts=${ts};h1=${sign(body).slice(2)}`]) {
      expect(verifyPaddleSignature(h, body, SECRET, now)).toBe(false);
    }
    expect(verifyPaddleSignature(`ts=${ts};h1=${sign(body, ts, "")}`, body, "", now)).toBe(false);
  });
});

const USER = "5b0e7f2c-8a8d-4b8e-9d62-0c6a3b3f4e11";
function subEvent(type: string, data: Record<string, unknown>) {
  return {
    event_id: "evt_01h",
    event_type: type,
    occurred_at: "2026-06-01T10:18:49.621022Z",
    notification_id: "ntf_1",
    data: {
      id: "sub_01",
      status: "active",
      customer_id: "ctm_01",
      custom_data: { user_id: USER },
      items: [{ quantity: 1, price: { id: "pri_month", billing_cycle: { interval: "month", frequency: 1 } } }],
      billing_cycle: { interval: "month", frequency: 1 },
      current_billing_period: { starts_at: "2026-06-01T10:18:48Z", ends_at: "2026-07-01T10:18:48Z" },
      scheduled_change: null,
      canceled_at: null,
      ...data,
    },
  };
}

describe("event → subscription change", () => {
  it("subscription.created: active, with user, price, interval and period end", () => {
    const r = parsePaddleEvent(subEvent("subscription.created", {}));
    expect(r).toEqual({
      kind: "apply",
      event: {
        eventId: "evt_01h",
        eventType: "subscription.created",
        occurredAt: new Date("2026-06-01T10:18:49.621Z"),
        userId: USER,
        subscriptionId: "sub_01",
        customerId: "ctm_01",
        status: "active",
        priceId: "pri_month",
        interval: "month",
        periodEnd: new Date("2026-07-01T10:18:48Z"),
        cancelAt: null,
      },
    });
  });

  it("a scheduled cancel sets cancelAt; the status stays active", () => {
    const r = parsePaddleEvent(
      subEvent("subscription.updated", { scheduled_change: { action: "cancel", effective_at: "2026-07-01T10:18:48Z", resume_at: null } }),
    );
    expect(r.kind === "apply" && r.event.status).toBe("active");
    expect(r.kind === "apply" && r.event.cancelAt).toEqual(new Date("2026-07-01T10:18:48Z"));
  });

  it("a scheduled pause is not a cancel", () => {
    const r = parsePaddleEvent(subEvent("subscription.updated", { scheduled_change: { action: "pause", effective_at: "2026-07-01T10:18:48Z" } }));
    expect(r.kind === "apply" && r.event.cancelAt).toBeNull();
  });

  it.each([
    ["subscription.canceled", "canceled"],
    ["subscription.past_due", "past_due"],
    ["subscription.paused", "paused"],
    ["subscription.resumed", "active"],
    ["subscription.trialing", "trialing"],
  ])("%s carries status %s", (type, status) => {
    const r = parsePaddleEvent(
      subEvent(type, { status, current_billing_period: null, canceled_at: status === "canceled" ? "2026-06-02T00:00:00Z" : null }),
    );
    expect(r.kind).toBe("apply");
    if (r.kind !== "apply") return;
    expect(r.event.status).toBe(status);
    expect(r.event.periodEnd).toBeNull();
    expect(r.event.cancelAt).toEqual(status === "canceled" ? new Date("2026-06-02T00:00:00Z") : null);
  });

  it("transaction.completed for a subscription is a payment (no status)", () => {
    const r = parsePaddleEvent({
      event_id: "evt_tx",
      event_type: "transaction.completed",
      occurred_at: "2026-06-01T10:18:50Z",
      data: {
        id: "txn_01",
        status: "completed",
        subscription_id: "sub_01",
        customer_id: "ctm_01",
        custom_data: { user_id: USER },
        items: [{ price: { id: "pri_year", billing_cycle: { interval: "year", frequency: 1 } } }],
        billing_period: { starts_at: "2026-06-01T10:18:48Z", ends_at: "2027-06-01T10:18:48Z" },
      },
    });
    expect(r.kind === "apply" && r.event).toMatchObject({
      status: null,
      subscriptionId: "sub_01",
      priceId: "pri_year",
      interval: "year",
      periodEnd: new Date("2027-06-01T10:18:48Z"),
    });
  });

  it("ignores one-off transactions and other event types; rejects malformed bodies", () => {
    expect(
      parsePaddleEvent({ event_id: "e", event_type: "transaction.completed", occurred_at: "2026-06-01T00:00:00Z", data: { id: "txn_1" } }).kind,
    ).toBe("ignore");
    expect(parsePaddleEvent({ event_id: "e", event_type: "customer.updated", occurred_at: "2026-06-01T00:00:00Z", data: {} }).kind).toBe("ignore");
    expect(parsePaddleEvent({ event_type: "subscription.created" }).kind).toBe("invalid");
    expect(parsePaddleEvent(subEvent("subscription.created", { status: "weird" })).kind).toBe("invalid");
    expect(parsePaddleEvent(null).kind).toBe("invalid");
  });

  it("only a well-formed user id is taken from custom_data", () => {
    for (const custom_data of [null, {}, { user_id: 42 }, { user_id: "'; DROP TABLE users; --" }]) {
      const r = parsePaddleEvent(subEvent("subscription.created", { custom_data }));
      expect(r.kind === "apply" && r.event.userId).toBeNull();
    }
  });
});

describe("customer portal link", () => {
  const response = (host: string) => ({
    data: {
      urls: {
        general: { overview: `https://${host}/cpl_1?action=overview&token=x` },
        subscriptions: [
          {
            id: "sub_01",
            cancel_subscription: `https://${host}/cpl_1?action=cancel_subscription&subscription_id=sub_01&token=x`,
            update_subscription_payment_method: `https://${host}/cpl_1?action=update_subscription_payment_method&subscription_id=sub_01&token=x`,
          },
        ],
      },
    },
  });
  it("picks the requested link", () => {
    const r = response("sandbox-customer-portal.paddle.com");
    expect(portalUrl(r, "cancel", "sub_01", "sandbox")).toContain("action=cancel_subscription");
    expect(portalUrl(r, "payment", "sub_01", "sandbox")).toContain("update_subscription_payment_method");
    expect(portalUrl(r, "overview", null, "sandbox")).toContain("action=overview");
    expect(portalUrl(r, "cancel", "sub_other", "sandbox")).toBeNull();
  });
  it("refuses links to any other host", () => {
    expect(portalUrl(response("evil.example"), "overview", null, "sandbox")).toBeNull();
    expect(portalUrl(response("sandbox-customer-portal.paddle.com"), "overview", null, "production")).toBeNull();
    expect(portalUrl({}, "overview", null, "sandbox")).toBeNull();
  });
});

describe("environments", () => {
  it("sandbox and production hosts differ only by prefix", () => {
    expect(paddleHosts("sandbox").frame).toBe("https://sandbox-buy.paddle.com");
    expect(paddleHosts("production").frame).toBe("https://buy.paddle.com");
    expect(paddleHosts("production").api).toBe("https://api.paddle.com");
  });
  it("checkout language falls back to English where Paddle has none", () => {
    expect(checkoutLocale("fa")).toBe("en");
    expect(checkoutLocale("ar")).toBe("ar");
  });
});
