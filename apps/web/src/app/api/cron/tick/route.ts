import { asBilling, expireSubscriptions } from "@poker/db";
import { authorizedCron } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { getBot } from "@/telegram/instance";
import { runReminders } from "@/telegram/notifications";

export const dynamic = "force-dynamic";

/** Called every ~10 minutes by the scheduler: plan expiry, game-night and debt reminders (Telegram and email). */
export async function POST(request: Request) {
  if (!authorizedCron(request)) return new Response(null, { status: 401 });
  // Pro ends when a canceled subscription's paid period is over, even without a webhook.
  const expired = await asBilling(getDb(), (tx) => expireSubscriptions(tx));
  // Without Telegram the email reminders still go out.
  const bot = await getBot();
  return Response.json({ expired, ...(await runReminders(getDb(), bot?.api ?? null)) });
}
