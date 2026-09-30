"use server";

import { adminEndSessions, adminOpenHome, adminSetPlan, asAuth } from "@poker/db";
import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { requireAdmin } from "@/lib/admin";
import { getDb } from "@/lib/db";
import { errorCode } from "@/lib/session";

const uuid = (v: FormDataEntryValue | null) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

async function back(path: string): Promise<never> {
  return redirect({ href: path, locale: await getLocale() });
}

async function run(path: string, fn: () => Promise<unknown>): Promise<never> {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = /reason/.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message)) ? "REASON" : errorCode(e);
  }
  const sep = path.includes("?") ? "&" : "?";
  return back(error ? `${path}${sep}error=${error}` : `${path}${sep}done=1`);
}

export async function adminSetPlanAction(form: FormData) {
  const admin = await requireAdmin();
  const userId = uuid(form.get("userId"));
  const plan = form.get("plan") === "pro" ? "pro" : "free";
  const q = String(form.get("q") ?? "");
  const path = `/admin?q=${encodeURIComponent(q)}`;
  if (!userId) return back(path);
  return run(path, () => asAuth(getDb(), (tx) => adminSetPlan(tx, admin.id, userId, plan, String(form.get("reason") ?? ""))));
}

export async function adminEndSessionsAction(form: FormData) {
  const admin = await requireAdmin();
  const userId = uuid(form.get("userId"));
  const q = String(form.get("q") ?? "");
  const path = `/admin?q=${encodeURIComponent(q)}`;
  if (!userId) return back(path);
  return run(path, () => asAuth(getDb(), (tx) => adminEndSessions(tx, admin.id, userId, String(form.get("reason") ?? ""))));
}

export async function adminOpenHomeAction(form: FormData) {
  const admin = await requireAdmin();
  const homeId = uuid(form.get("homeId"));
  if (!homeId) return back("/admin?error=NOT_FOUND");
  let error: string | null = null;
  try {
    await asAuth(getDb(), (tx) => adminOpenHome(tx, admin.id, homeId, String(form.get("reason") ?? "")));
  } catch (e) {
    error = /reason/.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message)) ? "REASON" : errorCode(e);
  }
  return back(error ? `/admin?error=${error}` : `/admin/homes/${homeId}`);
}
