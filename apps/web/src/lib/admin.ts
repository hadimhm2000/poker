import "server-only";
import { asAuth, schema } from "@poker/db";
import { eq } from "@poker/db";
import { notFound } from "next/navigation";
import { getDb } from "./db";
import { type SessionUser } from "./auth";
import { requireUser } from "./session";

/** ADMIN_EMAILS: comma-separated addresses of the site admins (support). */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The signed-in admin, or a plain 404 (the page does not reveal it exists). An admin needs a
 * listed, confirmed email and two-step verification turned on and passed in this session.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  const email = user.email?.toLowerCase();
  if (!email || !user.emailVerified || !adminEmails().includes(email)) notFound();
  const [u] = await asAuth(getDb(), (tx) =>
    tx.select({ totp: schema.users.totpEnabledAt }).from(schema.users).where(eq(schema.users.id, user.id)),
  );
  if (!u?.totp) notFound();
  return user;
}

export const isAdmin = (user: Pick<SessionUser, "email" | "emailVerified"> | null) =>
  !!user?.email && user.emailVerified && adminEmails().includes(user.email.toLowerCase());
