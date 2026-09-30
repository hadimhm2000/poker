import "server-only";
import { type Tx, asUser } from "@poker/db";
import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { type SessionUser, currentUser } from "./auth";
import { getDb } from "./db";

/** The signed-in user, or a redirect to sign-in (or to the second factor). */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) return redirect({ href: "/signin", locale });
  if (user.needsTwoFactor) return redirect({ href: "/signin/2fa", locale });
  return user;
}

/** Run database work as the signed-in user; Row Level Security applies to everything inside. */
export async function withUser<T>(fn: (tx: Tx, user: SessionUser) => Promise<T>): Promise<T> {
  const user = await requireUser();
  return asUser(getDb(), user.id, (tx) => fn(tx, user));
}

/** Postgres error hint/message → a stable code the UI can translate. */
export function errorCode(e: unknown): string {
  const err = e as { code?: string; message?: string; cause?: { message?: string; hint?: string } };
  const text = `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  if (err.code && /^[A-Z_]+$/.test(err.code)) return err.code;
  if (err.cause?.hint === "upgrade" || /limit|free plan/.test(text)) return "LIMIT";
  if (/read-only/.test(text)) return "READ_ONLY";
  if (/already have a player/.test(text)) return "ALREADY_LINKED";
  if (/cannot be claimed/.test(text)) return "NOT_FOUND";
  if (/invite is not valid/.test(text)) return "INVITE_INVALID";
  if (/closed and cannot be changed/.test(text)) return "FROZEN";
  if (/players_home_name_idx|duplicate key/.test(text)) return "DUPLICATE";
  if (/row-level security|permission denied/.test(text)) return "FORBIDDEN";
  return "ERROR";
}
