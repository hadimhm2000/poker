// Paddle Billing (merchant of record; plan: architecture "Paddle or Lemon Squeezy").
// Pure helpers (signature check, event → subscription change) are tested without network;
// the only outgoing call is the customer portal session in createPortalSession().
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingEvent } from "@poker/db";
import { z } from "zod";
import { type PaddleEnv, paddleHosts } from "./paddle-hosts";

export { type PaddleEnv, paddleHosts };

export function paddleEnv(): PaddleEnv {
  return process.env.PADDLE_ENV === "production" ? "production" : "sandbox";
}

/** Everything the checkout needs, or null when payments are not configured. */
export function checkoutConfig() {
  const token = process.env.PADDLE_CLIENT_TOKEN ?? "";
  const monthly = process.env.PADDLE_PRICE_MONTHLY ?? "";
  const yearly = process.env.PADDLE_PRICE_YEARLY ?? "";
  if (!token || !monthly || !yearly) return null;
  return { token, env: paddleEnv(), monthly, yearly };
}

export const portalConfigured = () => !!process.env.PADDLE_API_KEY;

// ---------------------------------------------------------------- webhook signature

/**
 * Paddle-Signature: "ts=<unix seconds>;h1=<hex HMAC-SHA256(secret, ts + ':' + raw body)>".
 * During a secret rotation several h1 values may be present; any match is enough.
 * Timestamps more than `toleranceSec` away from now are refused (replays).
 */
export function verifyPaddleSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowMs = Date.now(),
  toleranceSec = 300,
): boolean {
  if (!header || !secret || header.length > 1000) return false;
  let ts = "";
  const sigs: string[] = [];
  for (const part of header.split(";")) {
    const [k, v] = part.split("=", 2).map((x) => x.trim());
    if (k === "ts" && v) ts = v;
    else if (k === "h1" && v) sigs.push(v);
  }
  if (!/^\d{1,12}$/.test(ts) || sigs.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest();
  return sigs.some((h) => {
    if (!/^[0-9a-f]{64}$/i.test(h)) return false;
    return timingSafeEqual(Buffer.from(h, "hex"), expected);
  });
}

// ---------------------------------------------------------------- event → subscription change

const id = z.string().min(1).max(100);
const when = z.string().datetime({ offset: true });
const interval = z.enum(["day", "week", "month", "year"]);
const customData = z.record(z.string(), z.unknown()).nullish();
const item = z.object({ price: z.object({ id, billing_cycle: z.object({ interval }).nullish() }).nullish() });

const subscriptionData = z.object({
  id,
  status: z.enum(["active", "trialing", "past_due", "paused", "canceled"]),
  customer_id: id.nullish(),
  custom_data: customData,
  items: z.array(item).nullish(),
  billing_cycle: z.object({ interval }).nullish(),
  current_billing_period: z.object({ ends_at: when }).nullish(),
  scheduled_change: z.object({ action: z.string(), effective_at: when }).nullish(),
  canceled_at: when.nullish(),
});

const transactionData = z.object({
  id,
  subscription_id: id.nullish(),
  customer_id: id.nullish(),
  custom_data: customData,
  items: z.array(item).nullish(),
  billing_period: z.object({ ends_at: when }).nullish(),
});

const envelope = z.object({ event_id: id, event_type: z.string().min(1).max(100), occurred_at: when, data: z.unknown() });

export const SUBSCRIPTION_EVENTS = [
  "subscription.created",
  "subscription.updated",
  "subscription.activated",
  "subscription.trialing",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userFrom = (c: Record<string, unknown> | null | undefined) =>
  typeof c?.user_id === "string" && UUID.test(c.user_id) ? c.user_id : null;
const date = (s: string | null | undefined) => (s ? new Date(s) : null);

export type ParsedEvent = { kind: "apply"; event: BillingEvent } | { kind: "ignore" } | { kind: "invalid" };

/** A verified webhook body → the change to apply. Unknown event types are ignored. */
export function parsePaddleEvent(body: unknown): ParsedEvent {
  const env = envelope.safeParse(body);
  if (!env.success) return { kind: "invalid" };
  const { event_id, event_type, occurred_at, data } = env.data;
  const base = { eventId: event_id, eventType: event_type, occurredAt: new Date(occurred_at) };

  if ((SUBSCRIPTION_EVENTS as readonly string[]).includes(event_type)) {
    const s = subscriptionData.safeParse(data);
    if (!s.success) return { kind: "invalid" };
    const d = s.data;
    const price = d.items?.find((i) => i.price)?.price ?? null;
    const cancelAt =
      d.scheduled_change?.action === "cancel" ? d.scheduled_change.effective_at : d.status === "canceled" ? d.canceled_at : null;
    return {
      kind: "apply",
      event: {
        ...base,
        userId: userFrom(d.custom_data),
        subscriptionId: d.id,
        customerId: d.customer_id ?? null,
        status: d.status,
        priceId: price?.id ?? null,
        interval: d.billing_cycle?.interval ?? price?.billing_cycle?.interval ?? null,
        periodEnd: date(d.current_billing_period?.ends_at),
        cancelAt: date(cancelAt),
      },
    };
  }

  if (event_type === "transaction.completed") {
    const t = transactionData.safeParse(data);
    if (!t.success) return { kind: "invalid" };
    const d = t.data;
    // One-off purchases do not change the plan.
    if (!d.subscription_id) return { kind: "ignore" };
    const price = d.items?.find((i) => i.price)?.price ?? null;
    return {
      kind: "apply",
      event: {
        ...base,
        userId: userFrom(d.custom_data),
        subscriptionId: d.subscription_id,
        customerId: d.customer_id ?? null,
        status: null,
        priceId: price?.id ?? null,
        interval: price?.billing_cycle?.interval ?? null,
        periodEnd: date(d.billing_period?.ends_at),
        cancelAt: null,
      },
    };
  }
  return { kind: "ignore" };
}

// ---------------------------------------------------------------- customer portal

const portalResponse = z.object({
  data: z.object({
    urls: z.object({
      general: z.object({ overview: z.string().url() }),
      subscriptions: z
        .array(z.object({ id, cancel_subscription: z.string().url(), update_subscription_payment_method: z.string().url() }))
        .default([]),
    }),
  }),
});

export type PortalTarget = "overview" | "cancel" | "payment";

/** Pick the link for `target` and make sure it points at Paddle's portal. */
export function portalUrl(body: unknown, target: PortalTarget, subscriptionId: string | null, env: PaddleEnv): string | null {
  const r = portalResponse.safeParse(body);
  if (!r.success) return null;
  const sub = r.data.data.urls.subscriptions.find((s) => s.id === subscriptionId);
  const url =
    target === "cancel" ? sub?.cancel_subscription : target === "payment" ? sub?.update_subscription_payment_method : r.data.data.urls.general.overview;
  if (!url) return null;
  const u = new URL(url);
  return `${u.protocol}//${u.host}` === paddleHosts(env).portal ? u.toString() : null;
}

/** Create an authenticated customer portal session (Paddle API). Server only. */
export async function createPortalSession(customerId: string, subscriptionId: string | null, target: PortalTarget) {
  const key = process.env.PADDLE_API_KEY;
  if (!key || !/^ctm_[a-z0-9]+$/i.test(customerId)) return null;
  const env = paddleEnv();
  const res = await fetch(`${paddleHosts(env).api}/customers/${customerId}/portal-sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(subscriptionId ? { subscription_ids: [subscriptionId] } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return portalUrl(await res.json(), target, subscriptionId, env);
}

/** Paddle checkout languages; Persian is not offered, so it falls back to English. */
export function checkoutLocale(locale: string): string {
  return ["en", "ar", "fr", "it", "ru", "es"].includes(locale) ? locale : "en";
}
