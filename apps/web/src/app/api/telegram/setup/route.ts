import { locales } from "@/i18n/routing";
import { getBot } from "@/telegram/instance";
import { botT } from "@/telegram/i18n";
import { authorizedCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const COMMANDS = ["game", "rebuy", "judge", "draw", "stats", "last", "debts", "next", "sidepot", "rules", "help"] as const;

/**
 * One-time setup after deploy (same bearer secret as the cron):
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/telegram/setup
 * Sets the webhook with its secret token, the command menu in all 7 languages, and the
 * menu button that opens the Mini App.
 */
export async function POST(request: Request) {
  if (!authorizedCron(request)) return new Response(null, { status: 401 });
  const bot = await getBot();
  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!bot || !appUrl.startsWith("https://") || secret.length < 16) {
    return Response.json({ error: "set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET (16+ chars) and an https APP_URL" }, { status: 400 });
  }
  await bot.api.setWebhook(`${appUrl}/api/telegram/webhook`, {
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  for (const locale of locales) {
    const t = botT(locale);
    const commands = COMMANDS.map((c) => ({ command: c, description: t(`cmd_${c}`) }));
    await bot.api.setMyCommands(commands, locale === "en" ? {} : { language_code: locale });
  }
  await bot.api.setChatMenuButton({
    menu_button: { type: "web_app", text: "Poker Home", web_app: { url: `${appUrl}/en/tg` } },
  });
  return Response.json({ ok: true, bot: bot.botInfo.username });
}
