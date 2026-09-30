import { authorizedCron } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { getBot } from "@/telegram/instance";
import { runReminders } from "@/telegram/notifications";

export const dynamic = "force-dynamic";

/** Called every ~10 minutes by the scheduler: game-night and debt reminders (Telegram and email). */
export async function POST(request: Request) {
  if (!authorizedCron(request)) return new Response(null, { status: 401 });
  // Without Telegram the email reminders still go out.
  const bot = await getBot();
  return Response.json(await runReminders(getDb(), bot?.api ?? null));
}
