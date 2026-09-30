"use server";

import { desc, schema } from "@poker/db";
import { redirect as externalRedirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { createPortalSession } from "@/lib/paddle";
import { withUser } from "@/lib/session";

const target = z.enum(["overview", "cancel", "payment"]);

async function back(error: string): Promise<never> {
  const locale = await getLocale();
  return redirect({ href: `/account/billing?error=${error}`, locale });
}

/** Open Paddle's customer portal (cancel, invoices, payment method) for the signed-in user. */
export async function openPortalAction(form: FormData) {
  const t = target.safeParse(form.get("target"));
  if (!t.success) return back("INVALID");
  // RLS: only the user's own subscriptions are visible.
  const [sub] = await withUser((tx) =>
    tx
      .select({ id: schema.subscriptions.providerRef, customer: schema.subscriptions.customerRef, status: schema.subscriptions.status })
      .from(schema.subscriptions)
      .orderBy(desc(schema.subscriptions.updatedAt))
      .limit(1),
  );
  if (!sub?.customer) return back("NOT_FOUND");
  let url: string | null = null;
  try {
    url = await createPortalSession(sub.customer, sub.status === "canceled" ? null : sub.id, t.data);
  } catch (e) {
    console.error("paddle portal session failed", e instanceof Error ? e.message : e);
  }
  if (!url) return back("portal");
  externalRedirect(url);
}
