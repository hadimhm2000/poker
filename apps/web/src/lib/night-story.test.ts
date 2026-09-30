// Night story: a mocked Anthropic client, so no key and no network.
import type { NightFacts } from "@poker/db";
import { describe, expect, it } from "vitest";
import { STORY_MODEL, type StoryClient, generateStory, storyFacts, storyIsFaithful } from "./night-story";

const facts: NightFacts = {
  gameId: "00000000-0000-4000-8000-000000000001",
  homeId: "00000000-0000-4000-8000-000000000002",
  locale: "en",
  settings: { nightStory: true },
  money: { currency: "USD", unitSuffix: "k", unitDivisor: 1000 },
  number: 7,
  startedAt: new Date("2026-09-01T19:00:00Z"),
  closedAt: new Date("2026-09-01T23:30:00Z"),
  rows: [
    { playerId: "a", name: "Ali", totalIn: 300_000, cashOut: 0, rebuys: 2, net: -300_000 },
    { playerId: "b", name: "Sara", totalIn: 100_000, cashOut: 400_000, rebuys: 0, net: 300_000 },
  ],
  transfers: [{ from: "a", to: "b", amount: 300_000 }],
  biggestRebuy: 100_000,
};

function client(reply: { stop_reason?: string; content?: { type: string; text?: string }[] }) {
  const calls: Record<string, unknown>[] = [];
  const c = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { stop_reason: "end_turn", content: [], ...reply };
        },
      },
    },
  } as unknown as StoryClient;
  return { c, calls };
}

describe("storyFacts", () => {
  it("holds only this game's names and numbers, formatted as the home writes money", () => {
    const f = storyFacts(facts);
    expect(f.language).toBe("English");
    expect(f.game).toBe(7);
    expect(f.durationMinutes).toBe(270);
    expect(f.biggestWinner).toBe("Sara");
    expect(f.biggestLoser).toBe("Ali");
    expect(f.mostRebuys).toEqual({ name: "Ali", rebuys: 2 });
    expect(f.payments).toEqual([{ from: "Ali", to: "Sara", amount: f.players[1]!.result.replace(/^[-−]/, "") }]);
    const json = JSON.stringify(f);
    // No ids, settings or anything outside the game.
    expect(json).not.toMatch(/0000-4000|nightStory|USD/);
  });

  it("names the home's language", () => {
    expect(storyFacts({ ...facts, locale: "fa" }).language).toMatch(/Persian/);
  });
});

describe("storyIsFaithful", () => {
  const f = storyFacts(facts);
  it("accepts numbers from the facts and small counts", () => {
    expect(storyIsFaithful(`Sara took ${f.players[0]!.cashedOut} home after 2 hours; Ali bought 3 times.`, f)).toBe(true);
  });
  it("rejects a made-up figure, in any digits", () => {
    expect(storyIsFaithful("Ali lost 950k tonight.", f)).toBe(false);
    expect(storyIsFaithful("علی ۹۵۰k باخت", f)).toBe(false);
  });
});

describe("generateStory", () => {
  it("calls the model with low effort and server-side fallback", async () => {
    const { c, calls } = client({ content: [{ type: "text", text: "Sara ruled the table while Ali kept reloading." }] });
    expect(await generateStory(c, storyFacts(facts))).toBe("Sara ruled the table while Ali kept reloading.");
    expect(calls).toHaveLength(1);
    const p = calls[0]!;
    expect(p.model).toBe(STORY_MODEL);
    expect(p.output_config).toEqual({ effort: "low" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    const content = (p.messages as { content: string }[])[0]!.content;
    expect(JSON.parse(content)).toEqual(storyFacts(facts));
  });

  it("returns null on a refusal, an empty answer or an invented number", async () => {
    expect(await generateStory(client({ stop_reason: "refusal", content: [{ type: "text", text: "x" }] }).c, storyFacts(facts))).toBeNull();
    expect(await generateStory(client({ content: [] }).c, storyFacts(facts))).toBeNull();
    expect(await generateStory(client({ content: [{ type: "text", text: "Ali lost 777k." }] }).c, storyFacts(facts))).toBeNull();
  });
});
