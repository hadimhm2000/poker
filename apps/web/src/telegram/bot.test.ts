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
} from "@poker/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBot } from "./bot";
import { runReminders, sendGameClosed } from "./notifications";

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
const texts = (cs: Call[]) => cs.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => String(c.payload.text));

beforeAll(async () => {
  const root = postgres(base, { max: 1, onnotice: () => {} });
  await root.unsafe(`CREATE DATABASE ${name}`);
  await root.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  await migrate(url.toString());
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

  b = createBot({
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
  });
  b.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "sendMessage"
        ? { message_id: nextMessageId++, date: 0, chat: { id: (payload as { chat_id: number }).chat_id, type: "private" }, text: "" }
        : true;
    return { ok: true, result } as never;
  });
});
afterAll(() => end());

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
    const post = calls.find((c) => c.method === "sendMessage")!;
    expect(post.payload.chat_id).toBe(GROUP);
    expect(String(post.payload.text)).toMatch(/Abol ← Hadi/);
    expect(String(post.payload.text)).toMatch(/۱۵۰k/);
  });

  it("/stats, /stats name and /last", async () => {
    expect(texts(await send(message(FRIEND_TG, GROUP, "/stats")))[0]).toMatch(/🥇 Hadi/);
    expect(texts(await send(message(FRIEND_TG, GROUP, "/stats abol")))[0]).toMatch(/Abol/);
    expect(texts(await send(message(FRIEND_TG, GROUP, "/last")))[0]).toMatch(/شماره‌ی ۱/);
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
    const sent = await runReminders(db, bot().api);
    expect(sent.nights).toBe(1);
    expect(calls.map((c) => c.payload.chat_id).sort()).toEqual([GROUP, FRIEND_TG].sort());
    expect((await runReminders(db, bot().api)).nights).toBe(0);
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
