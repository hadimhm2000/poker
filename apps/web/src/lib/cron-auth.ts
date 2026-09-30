import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** Bearer CRON_SECRET check for the scheduler and the one-time Telegram setup. */
export function authorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  const got = request.headers.get("authorization") ?? "";
  if (secret.length < 16) return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}
