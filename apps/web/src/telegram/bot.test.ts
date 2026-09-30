// The bot end to end against a real database: every Telegram call is captured instead of
// sent, so this runs without a bot token or network. Needs Postgres (TEST_DATABASE_URL).
import { createHash, randomUUID } from "node:crypto";
import {
  type Db,
  addPlayer,
  addToGame,
  asAuth,
  asUser,
  closeGame,
  createDb,
  createGame,
  createHome,
  createLinkCode,
  createNight,
  migrate,
  setCashOut,
  setHomeSettings,
} from "@poker/db";
import { InputFile } from "grammy";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBot } from "./bot";
import { type StoryClient, writeNightStory } from "../lib/night-story";
import { runReminders, sendGameClosed, sendStory } from "./notifications";

const base = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/postgres";
const name = `poker_bot_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
let db: Db;
let end: () => Promise<void>;
let admin: ReturnType<typeof postgres>;

const HOST_TG = 1001;
const FRIEND_TG = 1002;
const STRANGER_TG = 1003;
const GROUP = -100500;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}
let calls: Call[] = [];
let nextMessageId = 100;
let updateId = 1;

const bot = () => b;
let b: ReturnType<typeof createBot>;
let host: string;
let friend: string;
let homeId: string;
let pHost: string;
let pFriend: string;
let pThird: string;
let gameId: string;

const sha = (s: string) => createHash("sha256").update(s).digest();

function message(from: number, chat: number, text: string) {
  const cmd = text.match(/^\/\w+/)?.[0];
  return {
    update_id: updateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: chat < 0 ? { id: chat, type: "supergroup" as const, title: "Friday poker" } : { id: chat, type: "private" as const, first_name: "X" },
      from: { id: from, is_bot: false, first_name: from === HOST_TG ? "Hadi" : "Abol", language_code: "fa" },
      text,
      entities: cmd ? [{ type: "bot_command" as const, offset: 0, length: cmd.length }] : undefined,
    },
  };
}

function callback(from: number, data: string) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      chat_instance: "ci",
      from: { id: from, is_bot: false, first_name: "U" },
      data,
      message: { message_id: 7, date: Math.floor(Date.now() / 1000), chat: { id: from, type: "private" as const, first_name: "U" }, text: "x" },
    },
  };
}

async function send(update: object) {
  calls = [];
  await bot().handleUpdate(update as never);
  return calls;
}
const texts = (cs: Call[]) =>
  cs
    .filter((c) => c.method === "sendMessage" || c.method === "editMessageText" || c.method === "sendPhoto")
    .map((c) => String(c.payload.text ?? c.payload.caption));

beforeAll(async () => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  // Roles are cluster-wide: migrate one test database at a time (same lock as packages/db tests).
  const root = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await root`SELECT pg_advisory_lock(727274)`;
    await root.unsafe(`CREATE DATABASE ${name}`);
    await migrate(url.toString());
  } finally {
    await root`SELECT pg_advisory_unlock(727274)`.catch(() => {});
    await root.end();
  }
  const made = createDb(url.toString(), { max: 10 });
  db = made.db;
  admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  end = async () => {
    await made.client.end();
    await admin.end();
    const r = postgres(base, { max: 1, onnotice: () => {} });
    await r.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await r.end();
  };

  [{ id: host }] = await admin`INSERT INTO users(email, plan, display_name, locale) VALUES ('h@t.local', 'pro', 'Hadi', 'fa') RETURNING id`;
  [{ id: friend }] = await admin`INSERT INTO users(email, display_name, locale) VALUES ('f@t.local', 'Abol', 'en') RETURNING id`;
  await asUser(db, host, async (tx) => {
    homeId = (await createHome(tx, host, { name: "Friday", locale: "fa", unitSuffix: "k", unitDivisor: 1000 })).id;
    pHost = (await addPlayer(tx, homeId, "Hadi")).id;
    pFriend = (await addPlayer(tx, homeId, "Abol")).id;
    pThird = (await addPlayer(tx, homeId, "Reza")).id;
  });
  await admin`UPDATE players SET user_id = ${host} WHERE id = ${pHost}`;
  await admin`UPDATE players SET user_id = ${friend} WHERE id = ${pFriend}`;
  await admin`INSERT INTO home_members(home_id, user_id, role, player_id) VALUES (${homeId}, ${friend}, 'member', ${pFriend})`;

  botCfg = {
    token: "1:test",
    db,
    appUrl: "https://poker.test",
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "Poker Home",
      username: "pokerhome_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  };
  b = createBot(botCfg);
  capture(b);
});
afterAll(() => end());

type BotCfg = Parameters<typeof createBot>[0];
let botCfg: BotCfg;

/** Every Telegram call of this bot is recorded in `calls` instead of sent. */
function capture(bb: ReturnType<typeof createBot>) {
  bb.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "sendMessage"
        ? { message_id: nextMessageId++, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: "private" }, text: "" }
        : true;
    return { ok: true, result } as never;
  });
}

describe("linking", () => {
  it("an unlinked user is told how to connect", async () => {
    const out = await send(message(STRANGER_TG, GROUP, "/rebuy"));
    expect(texts(out)[0]).toMatch(/connect|وصل/i);
  });

  it("links a Telegram account with a one-time code, once", async () => {
    const code = "A".repeat(43);
    await asAuth(db, (tx) => createLinkCode(tx, sha(code), { purpose: "account", userId: host }));
    expect(texts(await send(message(HOST_TG, HOST_TG, `/start ${code}`)))[0]).toMatch(/وصل شد/);
    const [u] = await admin`SELECT telegram_id FROM users WHERE id = ${host}`;
    expect(Number(u!.telegram_id)).toBe(HOST_TG);
    // Reusing the code does nothing.
    expect(texts(await send(message(STRANGER_TG, STRANGER_TG, `/start ${code}`)))[0]).toMatch(/not valid|معتبر نیست/);
    const code2 = "B".repeat(43);
    await asAuth(db, (tx) => createLinkCode(tx, sha(code2), { purpose: "account", userId: friend }));
    await send(message(FRIEND_TG, FRIEND_TG, `/start ${code2}`));
  });

  it("only the host who made the code can link a group", async () => {
    const code = "C".repeat(43);
    await asAuth(db, (tx) => createLinkCode(tx, sha(code), { purpose: "group", userId: host, homeId }));
    expect(texts(await send(message(FRIEND_TG, GROUP, `/start ${code}`)))[0]).toMatch(/Only the host/);
    const code2 = "D".repeat(43);
    await asAuth(db, (tx) => createLinkCode(tx, sha(code2), { purpose: "group", userId: host, homeId }));
    expect(texts(await send(message(HOST_TG, GROUP, `/start ${code2}`)))[0]).toMatch(/Friday/);
    const [h] = await admin`SELECT telegram_chat_id FROM homes WHERE id = ${homeId}`;
    expect(Number(h!.telegram_chat_id)).toBe(GROUP);
  });
});

describe("a game night from Telegram", () => {
  it("/game shows the live game", async () => {
    expect(texts(await send(message(FRIEND_TG, GROUP, "/game")))[0]).toMatch(/No game|بازی‌ای/);
    gameId = await asUser(db, host, async (tx) => {
      const g = await createGame(tx, host, homeId, 100_000);
      for (const p of [pHost, pFriend, pThird]) await addToGame(tx, host, g.id, p);
      return g.id;
    });
    const out = await send(message(FRIEND_TG, GROUP, "/game"));
    // Group replies are in the home's language (Persian here).
    expect(texts(out)[0]).toMatch(/۳ بازیکن/);
  });

  it("/rebuy in the group asks the host privately; the host approves with a tap", async () => {
    const out = await send(message(FRIEND_TG, GROUP, "/rebuy 50"));
    const dm = out.find((c) => c.method === "sendMessage" && c.payload.chat_id === HOST_TG)!;
    expect(dm).toBeTruthy();
    const kb = (dm.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
    const approve = kb[0]!.callback_data;
    expect(approve).toMatch(/^rq:a:/);
    // Asking again while waiting: refused.
    expect(texts(await send(message(FRIEND_TG, GROUP, "/rebuy")))[0]).toMatch(/منتظر/);
    // The friend cannot approve their own request.
    const denied = await send(callback(FRIEND_TG, approve));
    expect(denied.find((c) => c.method === "answerCallbackQuery")?.payload.show_alert).toBe(true);
    await send(callback(HOST_TG, approve));
    const [e] = await admin`SELECT total_in FROM game_entries WHERE game_id = ${gameId} AND player_id = ${pFriend}`;
    expect(Number(e!.total_in)).toBe(150_000);
    // A second tap on the same button adds nothing.
    await send(callback(HOST_TG, approve));
    const [e2] = await admin`SELECT total_in FROM game_entries WHERE game_id = ${gameId} AND player_id = ${pFriend}`;
    expect(Number(e2!.total_in)).toBe(150_000);
  });

  it("closing posts the result and settlement to the group", async () => {
    await asUser(db, host, async (tx) => {
      await setCashOut(tx, host, gameId, pHost, 250_000);
      await setCashOut(tx, host, gameId, pFriend, 0);
      await setCashOut(tx, host, gameId, pThird, 100_000);
    });
    const [v] = await admin`SELECT version FROM games WHERE id = ${gameId}`;
    await asUser(db, host, (tx) => closeGame(tx, host, { gameId, closeKey: randomUUID(), expectedVersion: v!.version }));
    calls = [];
    await sendGameClosed(db, bot().api, gameId, "https://poker.test");
    // The result card image, with the result and settlement as its caption.
    const post = calls.find((c) => c.method === "sendPhoto")!;
    expect(post.payload.chat_id).toBe(GROUP);
    expect(post.payload.photo).toBeInstanceOf(InputFile);
    expect(String(post.payload.caption)).toMatch(/Abol ← Hadi/);
    expect(String(post.payload.caption)).toMatch(/۱۵۰k/);
    const buttons = (post.payload.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0]!;
    const [hash] = await admin`SELECT hash FROM games WHERE id = ${gameId}`;
    expect(buttons.map((b) => b.url)).toContain(`https://poker.test/fa/verify/${hash!.hash}`);
  });

  it("/rules finds a situation in the group's language and adds the house rules", async () => {
    await admin`UPDATE homes SET house_rules = 'سقف rebuy: ۳ بار' WHERE telegram_chat_id = ${GROUP}`;
    const [text] = texts(await send(message(FRIEND_TG, GROUP, "/rules کیکر")));
    expect(text).toMatch(/<b>کیکر<\/b>/);
    expect(text).toMatch(/سقف rebuy/);
    // English keywords work in every language; the example comes from the hand engine.
    const [omaha] = texts(await send(message(FRIEND_TG, GROUP, "/rules omaha flush")));
    expect(omaha).toMatch(/اوماها: ۴ دل/);
    expect(omaha).toMatch(/3♥ 7♥ 9♥ J♥ 5♣/);
    // Anyone may ask in private, linked or not (here in their Telegram language); nothing found says so.
    const [none] = texts(await send(message(9_999_001, 9_999_001, "/rules zzzz")));
    expect(none).toMatch(/چیزی پیدا نشد/);
    const [list] = texts(await send(message(9_999_001, 9_999_001, "/rules")));
    expect(list).toMatch(/• کیکر/);
    expect(list).not.toMatch(/قوانین خانگی/);
  });

  it("/stats, /stats name and /last", async () => {
    expect(texts(await send(message(FRIEND_TG, GROUP, "/stats")))[0]).toMatch(/🥇 Hadi/);
    expect(texts(await send(message(FRIEND_TG, GROUP, "/stats abol")))[0]).toMatch(/Abol/);
    const last = await send(message(FRIEND_TG, GROUP, "/last"));
    expect(last[0]!.method).toBe("sendPhoto");
    expect(texts(last)[0]).toMatch(/شماره‌ی ۱/);
  });

  it("/debts: only the creditor (or host) can mark a debt paid", async () => {
    const out = await send(message(FRIEND_TG, GROUP, "/debts"));
    const kb = (out[0]!.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const paid = kb[0]![0]!.callback_data;
    const denied = await send(callback(FRIEND_TG, paid));
    expect(denied.find((c) => c.method === "answerCallbackQuery")?.payload.show_alert).toBe(true);
    const ok = await send(callback(HOST_TG, paid));
    expect(ok.find((c) => c.method === "answerCallbackQuery")?.payload.show_alert).toBeUndefined();
    expect(texts(await send(message(FRIEND_TG, GROUP, "/debts")))[0]).toMatch(/بدهی بازی نیست/);
  });

  it("/next shows the game night; members answer with buttons", async () => {
    const n = await asUser(db, host, (tx) => createNight(tx, host, { homeId, startsAt: new Date(Date.now() + 2 * 3600e3), place: "Hadi's" }));
    const out = await send(message(FRIEND_TG, GROUP, "/next"));
    expect(texts(out)[0]).toMatch(/Hadi's/);
    await send(callback(FRIEND_TG, `nv:${n.id}:y`));
    const [r] = await admin`SELECT answer FROM night_rsvps WHERE night_id = ${n.id} AND user_id = ${friend}`;
    expect(r!.answer).toBe("yes");
    // Reminders: the group and those coming, once.
    calls = [];
    // Abol has a confirmed email: the reminder also goes there (the host has none).
    await admin`UPDATE users SET email = 'abol-bot-test@example.com', email_verified_at = now() WHERE id = ${friend}`;
    const mails: { to: string; text: string }[] = [];
    const mail = async (m: { to: string; text: string }) => (mails.push(m), true);
    const sent = await runReminders(db, bot().api, { mail });
    expect(sent.nights).toBe(1);
    expect(calls.map((c) => c.payload.chat_id).sort()).toEqual([GROUP, FRIEND_TG].sort());
    expect(mails.map((m) => m.to)).toEqual(["abol-bot-test@example.com"]);
    expect(sent.emails).toBe(1);
    expect((await runReminders(db, bot().api, { mail })).nights).toBe(0);
  });

  it("debt reminders go privately to the debtor, never to the group", async () => {
    // A second game where Abol owes Hadi, closed "a week ago".
    const g = await asUser(db, host, async (tx) => {
      const g = await createGame(tx, host, homeId, 100_000);
      await addToGame(tx, host, g.id, pHost);
      await addToGame(tx, host, g.id, pFriend);
      await setCashOut(tx, host, g.id, pHost, 200_000);
      await setCashOut(tx, host, g.id, pFriend, 0);
      return g.id;
    });
    const [v] = await admin`SELECT version FROM games WHERE id = ${g}`;
    await asUser(db, host, (tx) => closeGame(tx, host, { gameId: g, closeKey: randomUUID(), expectedVersion: v!.version }));
    const later = new Date(Date.now() + 7 * 864e5);
    calls = [];
    const sent = await runReminders(db, bot().api, { now: later });
    expect(sent.debts).toBe(1);
    expect(calls.map((c) => c.payload.chat_id)).toEqual([FRIEND_TG]);
    expect(String(calls[0]!.payload.text)).toMatch(/you owe Hadi/);
    // Not again the same day.
    expect((await runReminders(db, bot().api, { now: later })).debts).toBe(0);
  });
});

describe("special ideas from Telegram", () => {
  let live: string;
  function voice(from: number, fileId: string, duration = 3) {
    return {
      update_id: updateId++,
      message: {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: GROUP, type: "supergroup" as const, title: "Friday poker" },
        from: { id: from, is_bot: false, first_name: "U", language_code: "fa" },
        voice: { file_id: fileId, file_unique_id: `u-${fileId}`, duration, mime_type: "audio/ogg", file_size: 4000 },
      },
    };
  }

  it("/judge records the verdict with the reason and a link to the rule", async () => {
    live = await asUser(db, host, async (tx) => {
      const g = await createGame(tx, host, homeId, 100_000);
      for (const p of [pHost, pFriend, pThird]) await addToGame(tx, host, g.id, p);
      return g.id;
    });
    const out = await send(message(FRIEND_TG, GROUP, "/judge As Kd 7h 7c 2s | Abol: Qc 4h | Hadi: Ac 2h"));
    const [text] = texts(out);
    expect(text).toMatch(/🏆 Hadi/);
    const kb = (out[0]!.payload.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0]!;
    expect(kb[0]!.url).toMatch(/^https:\/\/poker\.test\/fa\/rules#/);
    const rows = await admin`SELECT winners, via, actor_id FROM game_rulings WHERE game_id = ${live}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.winners).toEqual(["Hadi"]);
    expect(rows[0]!.via).toBe("telegram");
    expect(rows[0]!.actor_id).toBe(friend);
    // Nonsense is refused with the card rules; nothing recorded.
    expect(texts(await send(message(FRIEND_TG, GROUP, "/judge As As 7h 7c 2s | Qc 4h | Ac 2h")))[0]).toMatch(/پنج کارت/);
    expect(await admin`SELECT 1 FROM game_rulings WHERE game_id = ${live}`).toHaveLength(1);
  });

  it("/draw: only the host starts and reveals; the result carries the proof", async () => {
    await send(message(FRIEND_TG, GROUP, "/draw"));
    expect(await admin`SELECT 1 FROM game_draws WHERE game_id = ${live}`).toHaveLength(0);
    const out = await send(message(HOST_TG, GROUP, "/draw"));
    const [d] = await admin`SELECT id, commit FROM game_draws WHERE game_id = ${live}`;
    expect(texts(out)[0]).toContain(d!.commit);
    const kb = (out[0]!.payload.reply_markup as { inline_keyboard: { callback_data?: string; url?: string }[][] }).inline_keyboard;
    expect(kb[0]![0]!.url).toBe(`https://poker.test/fa/draws/${d!.id}`);
    const reveal = kb[1]![0]!.callback_data!;
    expect(reveal).toBe(`dr:r:${d!.id}`);
    // /draw again shows the same open draw.
    await send(message(HOST_TG, GROUP, "/draw"));
    expect(await admin`SELECT 1 FROM game_draws WHERE game_id = ${live}`).toHaveLength(1);
    const denied = await send(callback(FRIEND_TG, reveal));
    expect(denied.find((c) => c.method === "answerCallbackQuery")?.payload.show_alert).toBe(true);
    const ok = await send(callback(HOST_TG, reveal));
    const edited = ok.find((c) => c.method === "editMessageText")!;
    const [r] = await admin`SELECT seed, revealed_at FROM game_draws WHERE id = ${d!.id}`;
    expect(r!.revealed_at).not.toBeNull();
    expect(String(edited.payload.text)).toContain(r!.seed);
    expect(String(edited.payload.text)).toMatch(/Hadi|Abol|Reza/);
    // A second reveal is refused.
    expect((await send(callback(HOST_TG, reveal))).find((c) => c.method === "answerCallbackQuery")?.payload.show_alert).toBe(true);
  });

  it("a voice message says voice is off when no speech-to-text is configured", async () => {
    expect(texts(await send(voice(FRIEND_TG, "f0")))[0]).toMatch(/صوتی/);
  });

  it("a voice rebuy becomes a request the host approves with a tap", async () => {
    const heard: { audio: Uint8Array; language?: string }[] = [];
    let say = "";
    const vb = createBot({
      ...botCfg,
      transcribe: async (audio, opts) => {
        heard.push({ audio, language: opts.language });
        return say;
      },
      downloadFile: async (fileId) => new TextEncoder().encode(fileId),
    });
    capture(vb);
    const sendV = async (u: object) => {
      calls = [];
      await vb.handleUpdate(u as never);
      return calls;
    };

    // No rebuy word: silence.
    say = "سلام به همه";
    expect(await sendV(voice(HOST_TG, "v1"))).toHaveLength(0);
    expect(new TextDecoder().decode(heard[0]!.audio)).toBe("v1");
    expect(heard[0]!.language).toBe("fa");

    // Too long: refused before transcribing.
    expect(texts(await sendV(voice(HOST_TG, "v2", 90)))).toHaveLength(1);
    expect(heard).toHaveLength(1);

    // A member may ask only for themselves.
    say = "رضا ۲۰۰ ری‌بای";
    expect(texts(await sendV(voice(FRIEND_TG, "v3")))[0]).toMatch(/فقط خود Reza/);

    // The host asks for Reza: 200 in a "k" home is 200,000.
    const out = await sendV(voice(HOST_TG, "v4"));
    const msg = out.find((c) => c.method === "sendMessage")!;
    expect(msg.payload.chat_id).toBe(GROUP);
    expect(String(msg.payload.text)).toMatch(/Reza/);
    const kb = (msg.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
    expect(kb.map((k) => k.callback_data.slice(0, 5))).toEqual(["rq:a:", "rq:r:"]);
    const [req] = await admin`SELECT amount, details FROM game_events WHERE game_id = ${live} AND type = 'request' AND player_id = ${pThird}`;
    expect(Number(req!.amount)).toBe(200_000);
    expect(req!.details).toMatchObject({ via: "voice" });
    await send(callback(HOST_TG, kb[0]!.callback_data));
    const [e] = await admin`SELECT total_in FROM game_entries WHERE game_id = ${live} AND player_id = ${pThird}`;
    expect(Number(e!.total_in)).toBe(300_000);

    // English, own name, no amount: the game's default buy-in.
    say = "Abol rebuy please";
    const own = await sendV(voice(FRIEND_TG, "v5"));
    expect(texts(own)[0]).toMatch(/Abol/);
    const [req2] = await admin`SELECT amount FROM game_events WHERE game_id = ${live} AND type = 'request' AND player_id = ${pFriend} ORDER BY at DESC LIMIT 1`;
    expect(Number(req2!.amount)).toBe(100_000);
    // The host turns it down, so the game can close later.
    const kb2 = (own.find((c) => c.method === "sendMessage")!.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0]!;
    await send(callback(HOST_TG, kb2[1]!.callback_data));

    // Nobody by that name.
    say = "Zorro rebuy";
    expect(texts(await sendV(voice(HOST_TG, "v6")))[0]).toMatch(/Zorro/);
  });

  it("after close, the night story is written once and posted after the result card", async () => {
    await asUser(db, host, (tx) => setHomeSettings(tx, homeId, { nightStory: true }));
    await asUser(db, host, async (tx) => {
      await setCashOut(tx, host, live, pHost, 100_000);
      await setCashOut(tx, host, live, pFriend, 100_000);
      await setCashOut(tx, host, live, pThird, 300_000);
    });
    const [v] = await admin`SELECT version FROM games WHERE id = ${live}`;
    await asUser(db, host, (tx) => closeGame(tx, host, { gameId: live, closeKey: randomUUID(), expectedVersion: v!.version }));
    const prompts: string[] = [];
    const client = {
      beta: {
        messages: {
          create: async (p: { messages: { content: string }[] }) => {
            prompts.push(p.messages[0]!.content);
            return { stop_reason: "end_turn", content: [{ type: "text", text: "Reza stole the night; Hadi and Abol just watched." }] };
          },
        },
      },
    } as unknown as StoryClient;
    calls = [];
    await sendGameClosed(db, bot().api, live, "https://poker.test");
    expect(await writeNightStory(db, live, client)).toMatch(/Reza stole/);
    await sendStory(db, bot().api, live);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(String(calls[1]!.payload.text)).toMatch(/روایت شب[\s\S]*Reza stole/);
    // Only names and numbers of this game went to the model.
    expect(prompts[0]).toMatch(/Reza/);
    expect(prompts[0]).not.toMatch(/Friday|@t\.local|Hadi's/);
    // Once only.
    expect(await writeNightStory(db, live, client)).toBeNull();
    expect(prompts).toHaveLength(1);
    const [s] = await admin`SELECT body FROM game_stories WHERE game_id = ${live}`;
    expect(s!.body).toMatch(/Reza stole/);
  });
});
