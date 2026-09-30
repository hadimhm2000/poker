import "server-only";
import { getDb } from "@/lib/db";
import { writeNightStory } from "@/lib/night-story";
import { getBot } from "./instance";
import { sendDraw, sendGameClosed, sendNight, sendRebuyRequest, sendStory } from "./notifications";

// Fire-and-forget hooks called by the website after a change is committed (via after()).
// They do nothing when Telegram is not configured.

const appUrl = () => (process.env.APP_URL ?? "").replace(/\/$/, "");

export async function notifyRebuyRequest(requestId: string) {
  const bot = await getBot();
  if (bot) await sendRebuyRequest(getDb(), bot.api, requestId);
}

/**
 * After a close: the result card to the group, then (if the home turned it on and an
 * Anthropic key is set) the night story, stored with the game and posted after the card.
 */
export async function notifyGameClosed(gameId: string) {
  const bot = await getBot().catch((e: unknown) => {
    console.error("telegram bot unavailable", e);
    return null;
  });
  if (bot) await sendGameClosed(getDb(), bot.api, gameId, appUrl()).catch((e: unknown) => console.error("telegram notify failed", e));
  const story = await writeNightStory(getDb(), gameId).catch((e: unknown) => {
    console.error("night story failed", e);
    return null;
  });
  if (story && bot) await sendStory(getDb(), bot.api, gameId);
}

export async function notifyNight(nightId: string) {
  const bot = await getBot();
  if (bot) await sendNight(getDb(), bot.api, nightId);
}

export async function notifyDraw(drawId: string) {
  const bot = await getBot();
  if (bot) await sendDraw(getDb(), bot.api, drawId, appUrl());
}
