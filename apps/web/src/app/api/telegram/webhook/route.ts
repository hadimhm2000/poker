import { getBot } from "@/telegram/instance";
import { checkWebhookSecret } from "@/telegram/verify";

export const dynamic = "force-dynamic";

/** Telegram → bot. Only Telegram knows the secret token set with setWebhook. */
export async function POST(request: Request) {
  if (!checkWebhookSecret(request.headers.get("x-telegram-bot-api-secret-token"), process.env.TELEGRAM_WEBHOOK_SECRET ?? "")) {
    return new Response(null, { status: 401 });
  }
  const bot = await getBot();
  if (!bot) return new Response(null, { status: 503 });
  const update = await request.json().catch(() => null);
  if (!update || typeof update.update_id !== "number") return new Response(null, { status: 400 });
  // Answer 200 even if a handler fails (bot.catch logs it): Telegram would otherwise retry forever.
  await bot.handleUpdate(update).catch((e: unknown) => console.error("telegram update failed", e));
  return new Response(null, { status: 200 });
}
