import "server-only";
import { getDb } from "@/lib/db";
import { createTranscriber, sttConfig } from "@/lib/stt";
import { type PokerBot, createBot } from "./bot";

// Telegram settings (all from the secret manager / environment):
//   TELEGRAM_BOT_TOKEN        from BotFather
//   TELEGRAM_BOT_USERNAME     the bot's @username without @
//   TELEGRAM_WEBHOOK_SECRET   random string; Telegram sends it back on every webhook call
//   TELEGRAM_APP_NAME         optional Mini App short name (t.me/<bot>/<app>)
//   APP_URL                   public https origin of the site
//   STT_API_URL, STT_API_KEY, STT_MODEL   optional speech to text for voice rebuys (lib/stt.ts)
export const telegramConfigured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME);
export const botUsername = () => process.env.TELEGRAM_BOT_USERNAME ?? "";

const g = globalThis as unknown as { pokerBot?: Promise<PokerBot> };

/** The bot for this process, or null when Telegram is not configured. */
export async function getBot(): Promise<PokerBot | null> {
  if (!telegramConfigured()) return null;
  g.pokerBot ??= (async () => {
    const stt = sttConfig();
    const bot = createBot({
      token: process.env.TELEGRAM_BOT_TOKEN!,
      db: getDb(),
      appUrl: (process.env.APP_URL ?? "").replace(/\/$/, ""),
      appName: process.env.TELEGRAM_APP_NAME || undefined,
      transcribe: stt ? createTranscriber(stt) : null,
    });
    await bot.init();
    return bot;
  })().catch((e) => {
    g.pokerBot = undefined;
    throw e;
  });
  return g.pokerBot;
}
