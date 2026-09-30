// Night story (plan: special ideas #7): after a game closes, a short fun story of the night in
// the home's language, written by Claude from that game's own names and numbers. Nothing
// else about anyone goes into the prompt (no home name, no accounts, no other games).
// Enabled when ANTHROPIC_API_KEY is set and the host turned it on in the home's settings.
// It runs after the close response (after()); a failure only means there is no story.
import Anthropic from "@anthropic-ai/sdk";
import { type Db, type NightFacts, asJobs, gameStory, nightFacts, saveStory } from "@poker/db";
import { formatAmount } from "./format";

export const STORY_MODEL = "claude-opus-5-5";

const LANGUAGE: Record<string, string> = {
  fa: "Persian (Farsi)",
  en: "English",
  ar: "Arabic",
  fr: "French",
  it: "Italian",
  ru: "Russian",
  es: "Spanish",
};

const SYSTEM = `You write the "story of the night" for a group of friends who just finished a home poker game.
Write 3 to 5 short lines, warm and funny, like a sports commentator who knows everyone at the table.
Use only the facts you are given: the player names and the numbers exactly as written there.
Never invent a number, a hand, a card, an event or a name. If something is not in the facts, do not mention it.
Tease gently; never insult anyone. No hashtags, no markdown, no title. Plain text only.
Write the whole story in the language named in "language".`;

/** What the model sees: this game's names and numbers, formatted the way the home writes money. */
export function storyFacts(f: NightFacts) {
  const money = (n: number, signed = false) => formatAmount(n, f.money, f.locale, signed);
  const byNet = [...f.rows].sort((a, b) => b.net - a.net);
  const name = new Map(f.rows.map((r) => [r.playerId, r.name]));
  const mostRebuys = [...f.rows].sort((a, b) => b.rebuys - a.rebuys)[0];
  const minutes = f.startedAt ? Math.max(0, Math.round((f.closedAt.getTime() - f.startedAt.getTime()) / 60_000)) : null;
  return {
    language: LANGUAGE[f.locale] ?? "English",
    game: f.number,
    ...(minutes !== null ? { durationMinutes: minutes } : {}),
    pot: money(f.rows.reduce((s, r) => s + r.totalIn, 0)),
    players: byNet.map((r) => ({
      name: r.name,
      boughtIn: money(r.totalIn),
      cashedOut: money(r.cashOut),
      result: money(r.net, true),
      rebuys: r.rebuys,
    })),
    biggestWinner: byNet[0] && byNet[0].net > 0 ? byNet[0].name : null,
    biggestLoser: byNet.at(-1) && byNet.at(-1)!.net < 0 ? byNet.at(-1)!.name : null,
    mostRebuys: mostRebuys && mostRebuys.rebuys > 0 ? { name: mostRebuys.name, rebuys: mostRebuys.rebuys } : null,
    ...(f.biggestRebuy ? { biggestRebuy: money(f.biggestRebuy) } : {}),
    payments: f.transfers.map((t) => ({ from: name.get(t.from) ?? "?", to: name.get(t.to) ?? "?", amount: money(t.amount) })),
  };
}
export type StoryFacts = ReturnType<typeof storyFacts>;

const digitsOnly = (s: string) =>
  s
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/(\d)[,٬'’   ](?=\d{3})/g, "$1")
    .replace(/٫/g, ".");
const numbersIn = (s: string) => digitsOnly(s).match(/\d+(?:\.\d+)?/g) ?? [];

/**
 * The story may only repeat numbers that are in the facts (small counts like "2" aside), so
 * a made-up figure never reaches the group.
 */
export function storyIsFaithful(story: string, facts: StoryFacts): boolean {
  const allowed = new Set(numbersIn(JSON.stringify(facts)));
  return numbersIn(story).every((n) => allowed.has(n) || (Number.isInteger(Number(n)) && Number(n) <= 12));
}

export type StoryClient = Pick<Anthropic, "beta">;

/** Ask Claude for the story. Returns null on a refusal, an empty answer or an unfaithful one. */
export async function generateStory(client: StoryClient, facts: StoryFacts): Promise<string | null> {
  const res = await client.beta.messages.create({
    model: STORY_MODEL,
    max_tokens: 4000,
    // A short creative task: low effort is plenty.
    output_config: { effort: "low" },
    // If the model declines, the API retries on a fallback model it picks.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(facts) }],
  });
  if (res.stop_reason === "refusal") return null;
  const text = res.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim()
    .slice(0, 1200);
  if (!text || !storyIsFaithful(text, facts)) return null;
  return text;
}

let shared: Anthropic | null = null;
const defaultClient = (): StoryClient | null =>
  process.env.ANTHROPIC_API_KEY ? (shared ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000 })) : null;

/**
 * Write the story of a closed game once, if the home wants one. Runs as the jobs role (after
 * the close response). Returns the story, or null when there is none.
 */
export async function writeNightStory(db: Db, gameId: string, client: StoryClient | null = defaultClient()) {
  if (!client) return null;
  const f = await asJobs(db, (tx) => nightFacts(tx, gameId));
  if (!f || !f.settings.nightStory) return null;
  if (await asJobs(db, (tx) => gameStory(tx, gameId))) return null;
  const body = await generateStory(client, storyFacts(f));
  if (!body) return null;
  const saved = await asJobs(db, (tx) => saveStory(tx, { gameId, homeId: f.homeId, locale: f.locale, body, model: STORY_MODEL }));
  return saved ? body : null;
}
