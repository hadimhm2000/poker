import { asBilling, expireSubscriptions } from "@poker/db";
import { authorizedCron } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { getBot } from "@/telegram/instance";
import { runReminders } from "@/telegram/notifications";

export const dynamic = "force-dynamic";

/** Called every ~10 minutes by the scheduler: plan expiry, game-night and debt reminders. */
export async function POST(request: Request) {
  if (!authorizedCron(request)) return new Response(null, { status: 401 });
  // Pro ends when a canceled subscription's paid period is over, even without a webhook.
  const expired = await asBilling(getDb(), (tx) => expireSubscriptions(tx));
  const bot = await getBot();
  if (!bot) return Response.json({ expired, skipped: "telegram not configured" });
  return Response.json({ expired, ...(await runReminders(getDb(), bot.api)) });
}
