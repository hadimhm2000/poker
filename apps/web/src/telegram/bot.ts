// The Telegram bot: another door into the same backend (plan: "Multilingual and Telegram bot").
// Every action runs as the linked site user through asUser(), so RLS applies exactly as on
// the website; the bot never gets wider rights than the person pressing the button.
import { createHash } from "node:crypto";
import {
  type Db,
  DomainError,
  answerRequest,
  asAuth,
  asJobs,
  asUser,
  consumeLinkCode,
  linkTelegramAccount,
  liveGame,
  markPaid,
  requestRebuy,
  rsvp,
  schema,
  upcomingNights,
} from "@poker/db";
import { and, eq, isNull } from "@poker/db";
import { liveTotals } from "@poker/domain";
import { Bot, type Context, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { formatAmount, parseAmount } from "@/lib/format";
import { botLocale, botT, esc } from "./i18n";
import { cardOrNull, postResult, sendRebuyRequest } from "./notifications";
import { type Home, debtsText, lastGameText, nightText, rulesText, statsText } from "./text";

export interface BotConfig {
  token: string;
  db: Db;
  /** Public site origin, e.g. https://pokerhome.app */
  appUrl: string;
  /** Mini App short name from BotFather (t.me/<bot>/<app>); optional. */
  appName?: string;
  /** Given in tests (and after the first getMe) so no network call is needed. */
  botInfo?: UserFromGetMe;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const codeHash = (code: string) => createHash("sha256").update(code).digest();
const helpText = (t: ReturnType<typeof botT>) => `${t("help")}\n${t("helpRules")}`;

interface Linked {
  id: string;
  locale: string;
  displayName: string;
}

export function createBot(cfg: BotConfig) {
  const bot = new Bot(cfg.token, cfg.botInfo ? { botInfo: cfg.botInfo } : undefined);
  const { db, appUrl } = cfg;

  const siteUser = async (tgId: number): Promise<Linked | null> => {
    const [u] = await asAuth(db, (tx) =>
      tx
        .select({ id: schema.users.id, locale: schema.users.locale, displayName: schema.users.displayName })
        .from(schema.users)
        .where(and(eq(schema.users.telegramId, tgId), isNull(schema.users.deletedAt))),
    );
    return u ?? null;
  };

  const isGroup = (ctx: Context) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  /** Language for a reply: the home's in its group, else the user's, else Telegram's. */
  const tFor = (ctx: Context, user: Linked | null, home?: Home | null) =>
    botT(home?.locale ?? user?.locale ?? botLocale(ctx.from?.language_code?.slice(0, 2)));

  /** Link to open something inside Telegram (Mini App) or, without one, on the website. */
  const openLink = (locale: string, path: string, startParam: string) =>
    cfg.appName
      ? `https://t.me/${bot.botInfo.username}/${cfg.appName}?startapp=${startParam}`
      : `${appUrl}/${locale}${path}`;

  /** The home this command is about: the group's home, or in private the user's only home. */
  async function homeFor(ctx: Context, user: Linked): Promise<Home | null> {
    return asUser(db, user.id, async (tx) => {
      if (isGroup(ctx)) {
        const [h] = await tx.select().from(schema.homes).where(eq(schema.homes.telegramChatId, ctx.chat!.id));
        return h ?? null;
      }
      const hs = await tx.select().from(schema.homes).where(isNull(schema.homes.deletedAt));
      return hs.length === 1 ? hs[0]! : null;
    });
  }

  /** Common prelude: linked user + home, or a helpful reply and null. */
  async function context(ctx: Context) {
    const user = ctx.from ? await siteUser(ctx.from.id) : null;
    if (!user) {
      const t = tFor(ctx, null);
      await ctx.reply(esc(t("notLinked")), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url(t("connect"), `https://t.me/${bot.botInfo.username}?start=hello`),
      });
      return null;
    }
    const home = await homeFor(ctx, user);
    if (!home) {
      await ctx.reply(esc(tFor(ctx, user)(isGroup(ctx) ? "groupNotLinked" : "chooseHome")), { parse_mode: "HTML" });
      return null;
    }
    return { user, home, t: tFor(ctx, user, home) };
  }

  const errorText = (e: unknown) => {
    if (e instanceof DomainError) return e.code;
    const msg = `${(e as Error)?.message ?? ""} ${(e as { cause?: Error })?.cause?.message ?? ""}`;
    if (/row-level security|permission denied|not allowed/.test(msg)) return "FORBIDDEN";
    if (/closed and cannot be changed/.test(msg)) return "FROZEN";
    if (/duplicate key|already/.test(msg)) return "ALREADY";
    return "ERROR";
  };

  // ------------------------------------------------------------ /start, linking

  /** Group linking: /start <code> (from t.me/<bot>?startgroup=<code>) or /link <code>. */
  async function linkGroup(ctx: Context, code: string) {
    const user = ctx.from ? await siteUser(ctx.from.id) : null;
    const t = tFor(ctx, user);
    const c = await asAuth(db, (tx) => consumeLinkCode(tx, codeHash(code), "group"));
    if (!c) return ctx.reply(esc(t("linkInvalid")), { parse_mode: "HTML" });
    if (!user || user.id !== c.userId) return ctx.reply(esc(t("linkNotOwner")), { parse_mode: "HTML" });
    try {
      const home = await asUser(db, user.id, async (tx) => {
        const [h] = await tx
          .update(schema.homes)
          .set({ telegramChatId: ctx.chat!.id })
          .where(eq(schema.homes.id, c.homeId!))
          .returning();
        return h;
      });
      if (!home) return ctx.reply(esc(t("notAllowed")), { parse_mode: "HTML" });
      const th = botT(home.locale);
      return ctx.reply(esc(th("groupLinked", { home: home.name })), { parse_mode: "HTML" });
    } catch (e) {
      return ctx.reply(esc(t(errorText(e) === "ALREADY" ? "groupTaken" : "notAllowed")), { parse_mode: "HTML" });
    }
  }

  bot.command("start", async (ctx) => {
    const payload = ctx.match.trim();
    if (isGroup(ctx)) return payload ? linkGroup(ctx, payload) : ctx.reply(esc(helpText(tFor(ctx, null))), { parse_mode: "HTML" });
    // Account linking: t.me/<bot>?start=<code> made on the website's security page.
    if (/^[A-Za-z0-9_-]{20,64}$/.test(payload)) {
      const t = tFor(ctx, null);
      const c = await asAuth(db, (tx) => consumeLinkCode(tx, codeHash(payload), "account"));
      if (!c) return ctx.reply(esc(t("linkInvalid")), { parse_mode: "HTML" });
      try {
        await asAuth(db, (tx) => linkTelegramAccount(tx, c.userId, ctx.from!.id));
      } catch (e) {
        return ctx.reply(esc(t(errorText(e) === "TELEGRAM_TAKEN" ? "telegramTaken" : "notAllowed")), { parse_mode: "HTML" });
      }
      const u = await siteUser(ctx.from!.id);
      return ctx.reply(esc(tFor(ctx, u)("linked")), { parse_mode: "HTML" });
    }
    const user = await siteUser(ctx.from!.id);
    const t = tFor(ctx, user);
    const locale = user?.locale ?? botLocale(ctx.from?.language_code?.slice(0, 2));
    const kb = new InlineKeyboard().webApp(t("openApp"), `${appUrl}/${locale}/tg`);
    if (!user) kb.row().url(t("haveAccount"), `${appUrl}/${locale}/security`);
    const text = user ? t("welcomeLinked", { name: user.displayName || ctx.from!.first_name }) : t("welcome", { name: ctx.from!.first_name });
    return ctx.reply(`${esc(text)}\n\n${esc(helpText(t))}`, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.command("link", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply(esc(tFor(ctx, null)("groupOnly")), { parse_mode: "HTML" });
    const code = ctx.match.trim();
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return ctx.reply(esc(tFor(ctx, null)("linkInvalid")), { parse_mode: "HTML" });
    return linkGroup(ctx, code);
  });

  bot.command("help", (ctx) => ctx.reply(esc(helpText(tFor(ctx, null))), { parse_mode: "HTML" }));

  // ------------------------------------------------------------ live game

  bot.command("game", async (ctx) => {
    const c = await context(ctx);
    if (!c) return;
    const g = await asUser(db, c.user.id, (tx) => liveGame(tx, c.home.id));
    if (!g) return ctx.reply(esc(c.t("noLiveGame")), { parse_mode: "HTML" });
    const entries = await asUser(db, c.user.id, (tx) =>
      tx.select().from(schema.gameEntries).where(eq(schema.gameEntries.gameId, g.id)),
    );
    const totals = liveTotals(entries.map((e) => ({ playerId: e.playerId, totalIn: e.totalIn, cashOut: e.cashOut })));
    const text = c.t("gameLine", { players: entries.length, pot: formatAmount(totals.pot, c.home, c.home.locale) });
    return ctx.reply(esc(text), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().url(c.t("openGame"), openLink(c.home.locale, `/games/${g.id}`, `game_${g.id}`)),
    });
  });

  bot.command("rebuy", async (ctx) => {
    const c = await context(ctx);
    if (!c) return;
    const g = await asUser(db, c.user.id, (tx) => liveGame(tx, c.home.id));
    if (!g) return ctx.reply(esc(c.t("noLiveGame")), { parse_mode: "HTML" });
    const arg = ctx.match.trim();
    const amount = arg ? parseAmount(arg, c.home.unitDivisor) : undefined;
    if (amount === null || amount === 0) return ctx.reply(esc(c.t("badAmount")), { parse_mode: "HTML" });
    try {
      const r = await asUser(db, c.user.id, (tx) => requestRebuy(tx, c.user.id, g.id, amount));
      const [p] = await asUser(db, c.user.id, (tx) =>
        tx.select({ name: schema.players.displayName }).from(schema.players).where(eq(schema.players.id, r.playerId)),
      );
      await notifyHostOfRequest(r.requestId);
      return ctx.reply(
        esc(c.t("rebuyRequested", { name: p?.name ?? "?", amount: formatAmount(r.amount, c.home, c.home.locale) })),
        { parse_mode: "HTML" },
      );
    } catch (e) {
      const code = errorText(e);
      const key = code === "ALREADY_REQUESTED" ? "rebuyAlready" : code === "NOT_IN_GAME" ? "notInGame" : "notAllowed";
      return ctx.reply(esc(c.t(key)), { parse_mode: "HTML" });
    }
  });

  /** Private message to the host with approve / reject buttons. */
  const notifyHostOfRequest = (requestId: string) => sendRebuyRequest(db, bot.api, requestId).catch(() => {});

  bot.callbackQuery(new RegExp(`^rq:([ar]):(${UUID})$`), async (ctx) => {
    const user = await siteUser(ctx.from.id);
    const t = tFor(ctx, user);
    if (!user) return ctx.answerCallbackQuery({ text: t("notLinked"), show_alert: true });
    const approve = ctx.match[1] === "a";
    try {
      const r = await asUser(db, user.id, (tx) => answerRequest(tx, user.id, ctx.match[2]!, approve));
      const info = await asUser(db, user.id, async (tx) => {
        const [row] = await tx
          .select({ name: schema.players.displayName, home: schema.homes })
          .from(schema.players)
          .innerJoin(schema.homes, eq(schema.homes.id, schema.players.homeId))
          .where(eq(schema.players.id, r.playerId));
        return row!;
      });
      const amount = formatAmount(r.amount, info.home, info.home.locale);
      await ctx.answerCallbackQuery({ text: t(approve ? "approvedShort" : "rejectedShort") });
      return ctx.editMessageText(esc(t(approve ? "approved" : "rejected", { name: info.name, amount })), { parse_mode: "HTML" });
    } catch (e) {
      const code = errorText(e);
      return ctx.answerCallbackQuery({ text: t(code === "ALREADY_ANSWERED" ? "alreadyAnswered" : "notAllowed"), show_alert: true });
    }
  });

  // ------------------------------------------------------------ results, stats, debts

  bot.command("stats", async (ctx) => {
    const c = await context(ctx);
    if (!c) return;
    const text = await asUser(db, c.user.id, (tx) => statsText(tx, c.home, c.t, ctx.match.trim() || undefined));
    return ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("last", async (ctx) => {
    const c = await context(ctx);
    if (!c) return;
    const r = await asUser(db, c.user.id, async (tx) => {
      const last = await lastGameText(tx, c.home, c.t, appUrl);
      return last && { ...last, png: await cardOrNull(tx, last.gameId, appUrl) };
    });
    if (!r) return ctx.reply(esc(c.t("noGames")), { parse_mode: "HTML" });
    return postResult(ctx.api, ctx.chat!.id, r, r.png);
  });

  // Public knowledge: works for anyone, linked or not. In a home's group the house rules follow.
  bot.command("rules", async (ctx) => {
    const user = ctx.from ? await siteUser(ctx.from.id) : null;
    const home = isGroup(ctx)
      ? ((await asJobs(db, (tx) => tx.select().from(schema.homes).where(eq(schema.homes.telegramChatId, ctx.chat!.id))))[0] ?? null)
      : null;
    const locale = home?.locale ?? user?.locale ?? botLocale(ctx.from?.language_code?.slice(0, 2));
    const r = rulesText(ctx.match, locale, appUrl, home && { name: home.name, rules: home.houseRules });
    return ctx.reply(r.text, { parse_mode: "HTML", reply_markup: r.keyboard, link_preview_options: { is_disabled: true } });
  });

  bot.command("debts", async (ctx) => {
    const c = await context(ctx);
    if (!c) return;
    const r = await asUser(db, c.user.id, (tx) => debtsText(tx, c.home, c.t));
    return ctx.reply(r.text, { parse_mode: "HTML", reply_markup: r.keyboard });
  });

  bot.callbackQuery(new RegExp(`^pd:(${UUID})$`), async (ctx) => {
    const user = await siteUser(ctx.from.id);
    const t = tFor(ctx, user);
    if (!user) return ctx.answerCallbackQuery({ text: t("notLinked"), show_alert: true });
    try {
      const home = await asUser(db, user.id, async (tx) => {
        await markPaid(tx, user.id, ctx.match[1]!);
        const [row] = await tx
          .select({ home: schema.homes })
          .from(schema.settlements)
          .innerJoin(schema.games, eq(schema.games.id, schema.settlements.gameId))
          .innerJoin(schema.homes, eq(schema.homes.id, schema.games.homeId))
          .where(eq(schema.settlements.id, ctx.match[1]!));
        return row!.home;
      });
      await ctx.answerCallbackQuery({ text: t("paidDone") });
      const th = botT(home.locale);
      const r = await asUser(db, user.id, (tx) => debtsText(tx, home, th));
      return ctx.editMessageText(r.text, { parse_mode: "HTML", reply_markup: r.keyboard });
    } catch (e) {
      const code = errorText(e);
      return ctx.answerCallbackQuery({ text: t(code === "ALREADY" ? "alreadyAnswered" : "onlyCreditor"), show_alert: true });
    }
  });

  // ------------------------------------------------------------ game nights

  bot.command("next", async (ctx) => {
    const c = await context(ctx);
    if (!c) return;
    const [n] = await asUser(db, c.user.id, (tx) => upcomingNights(tx, c.home.id));
    if (!n) {
      return ctx.reply(esc(c.t("noNight")), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url(c.t("planNight"), `${appUrl}/${c.home.locale}/homes/${c.home.id}/nights`),
      });
    }
    const r = await asUser(db, c.user.id, (tx) => nightText(tx, c.home, n.id, c.t));
    return ctx.reply(r!.text, { parse_mode: "HTML", reply_markup: r!.keyboard });
  });

  bot.callbackQuery(new RegExp(`^nv:(${UUID}):([ymn])$`), async (ctx) => {
    const user = await siteUser(ctx.from.id);
    const t = tFor(ctx, user);
    if (!user) return ctx.answerCallbackQuery({ text: t("notLinked"), show_alert: true });
    const answer = ({ y: "yes", m: "maybe", n: "no" } as const)[ctx.match[2] as "y" | "m" | "n"];
    try {
      const r = await asUser(db, user.id, async (tx) => {
        const night = await rsvp(tx, user.id, ctx.match[1]!, answer);
        const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, night.homeId));
        return nightText(tx, home!, night.id, botT(home!.locale));
      });
      await ctx.answerCallbackQuery({ text: t(`rsvpSaved_${answer}`) });
      return ctx.editMessageText(r!.text, { parse_mode: "HTML", reply_markup: r!.keyboard }).catch(() => {});
    } catch {
      return ctx.answerCallbackQuery({ text: t("notAllowed"), show_alert: true });
    }
  });

  // ------------------------------------------------------------ tools

  bot.command("sidepot", (ctx) => {
    const t = tFor(ctx, null);
    const locale = botLocale(ctx.from?.language_code?.slice(0, 2));
    return ctx.reply(esc(t("sidepot")), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().url(t("sidepot"), openLink(locale, "/tools/sidepot", "sidepot")),
    });
  });

  bot.catch((err) => console.error("telegram bot error", err.error));

  return bot;
}

export type PokerBot = ReturnType<typeof createBot>;
