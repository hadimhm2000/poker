import "server-only";
import { getDb } from "@/lib/db";
import { getBot } from "./instance";
import { sendGameClosed, sendNight, sendRebuyRequest } from "./notifications";

// Fire-and-forget hooks called by the website after a change is committed (via after()).
// They do nothing when Telegram is not configured.

const appUrl = () => (process.env.APP_URL ?? "").replace(/\/$/, "");

export async function notifyRebuyRequest(requestId: string) {
  const bot = await getBot();
  if (bot) await sendRebuyRequest(getDb(), bot.api, requestId);
}

export async function notifyGameClosed(gameId: string) {
  const bot = await getBot();
  if (bot) await sendGameClosed(getDb(), bot.api, gameId, appUrl());
}

export async function notifyNight(nightId: string) {
  const bot = await getBot();
  if (bot) await sendNight(getDb(), bot.api, nightId);
}
