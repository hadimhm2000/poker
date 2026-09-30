import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "./client";

// Billing writes go only through the definer functions of 0006_billing.sql, called as
// app_billing (asBilling). None of this is reachable as app_user.

export const billingEventInput = z.object({
  eventId: z.string().min(1).max(100),
  eventType: z.string().min(1).max(100),
  occurredAt: z.date(),
  /** From checkout custom_data; trusted only because the webhook signature was checked. */
  userId: z.string().uuid().nullable(),
  subscriptionId: z.string().min(1).max(100),
  customerId: z.string().min(1).max(100).nullable(),
  /** null for a payment (transaction.completed). */
  status: z.enum(["active", "trialing", "past_due", "paused", "canceled"]).nullable(),
  priceId: z.string().min(1).max(100).nullable(),
  interval: z.enum(["day", "week", "month", "year"]).nullable(),
  periodEnd: z.date().nullable(),
  cancelAt: z.date().nullable(),
});
export type BillingEvent = z.infer<typeof billingEventInput>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Apply one verified provider event. Idempotent by event id. */
export async function applyBillingEvent(tx: Tx, input: BillingEvent): Promise<"applied" | "duplicate" | "unmapped"> {
  const e = billingEventInput.parse(input);
  const r = await tx.execute<{ r: "applied" | "duplicate" | "unmapped" }>(sql`
    SELECT app.billing_apply(${e.eventId}, ${e.eventType}, ${iso(e.occurredAt)}::timestamptz, ${e.userId}::uuid,
      ${e.subscriptionId}, ${e.customerId}, ${e.status}, ${e.priceId}, ${e.interval},
      ${iso(e.periodEnd)}::timestamptz, ${iso(e.cancelAt)}::timestamptz) AS r`);
  return r[0]!.r;
}

/** Drop Pro for users whose paid period ran out without a webhook. Returns how many. */
export async function expireSubscriptions(tx: Tx): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`SELECT app.billing_expire() AS n`);
  return Number(r[0]!.n);
}
