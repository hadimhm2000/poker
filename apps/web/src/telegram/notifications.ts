// Automatic Telegram messages (plan: bot table, "automatic" rows). They run outside any
// user's request, so they read through the narrow jobs role.
import { type Db, asJobs, schema } from "@poker/db";
import { and, eq, gt, isNull, lt, lte, sql } from "@poker/db";
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { formatAmount, formatDate } from "@/lib/format";
import { botT, esc } from "./i18n";
import { gameResultText, nightText } from "./text";

/** "X asks for a rebuy": a private message to the host with approve / reject buttons. */
export async function hostRequestMessage(db: Db, requestId: string) {
  return asJobs(db, async (tx) => {
    const [r] = await tx
      .select({
        amount: schema.gameEvents.amount,
        player: schema.players.displayName,
        home: schema.homes,
        hostTg: schema.users.telegramId,
        hostLocale: schema.users.locale,
      })
      .from(schema.gameEvents)
      .innerJoin(schema.games, eq(schema.games.id, schema.gameEvents.gameId))
      .innerJoin(schema.homes, eq(schema.homes.id, schema.games.homeId))
      .innerJoin(schema.users, eq(schema.users.id, schema.homes.ownerId))
      .innerJoin(schema.players, eq(schema.players.id, schema.gameEvents.playerId))
      .where(and(eq(schema.gameEvents.id, requestId), eq(schema.gameEvents.type, "request")));
    if (!r?.hostTg) return null;
    const t = botT(r.hostLocale);
    const amount = formatAmount(r.amount ?? 0, r.home, r.hostLocale);
    return {
      chatId: r.hostTg,
      text: esc(t("rebuyAsk", { name: r.player, amount, home: r.home.name })),
      keyboard: new InlineKeyboard().text(t("approve"), `rq:a:${requestId}`).text(t("reject"), `rq:r:${requestId}`),
    };
  });
}

export async function sendRebuyRequest(db: Db, api: Api, requestId: string) {
  const m = await hostRequestMessage(db, requestId);
  if (m) await api.sendMessage(m.chatId, m.text, { parse_mode: "HTML", reply_markup: m.keyboard });
}

/** On close: result and settlement to the home's group, in the home's language. */
export async function sendGameClosed(db: Db, api: Api, gameId: string, appUrl: string) {
  const m = await asJobs(db, async (tx) => {
    const [row] = await tx
      .select({ home: schema.homes })
      .from(schema.games)
      .innerJoin(schema.homes, eq(schema.homes.id, schema.games.homeId))
      .where(eq(schema.games.id, gameId));
    if (!row?.home.telegramChatId) return null;
    const r = await gameResultText(tx, row.home, gameId, botT(row.home.locale), appUrl);
    return r && { chatId: row.home.telegramChatId, ...r };
  });
  if (m) await api.sendMessage(m.chatId, m.text, { parse_mode: "HTML", reply_markup: m.keyboard });
}

/** A new (or changed) game night: post the invite with RSVP buttons to the group. */
export async function sendNight(db: Db, api: Api, nightId: string) {
  const m = await asJobs(db, async (tx) => {
    const [row] = await tx
      .select({ home: schema.homes, messageId: schema.gameNights.telegramMessageId, canceledAt: schema.gameNights.canceledAt })
      .from(schema.gameNights)
      .innerJoin(schema.homes, eq(schema.homes.id, schema.gameNights.homeId))
      .where(eq(schema.gameNights.id, nightId));
    if (!row?.home.telegramChatId || (row.canceledAt && !row.messageId)) return null;
    const r = await nightText(tx, row.home, nightId, botT(row.home.locale));
    return r && { chatId: row.home.telegramChatId, messageId: row.messageId, ...r };
  });
  if (!m) return;
  if (m.messageId) {
    await api.editMessageText(m.chatId, m.messageId, m.text, { parse_mode: "HTML", reply_markup: m.keyboard }).catch(() => {});
    return;
  }
  const sent = await api.sendMessage(m.chatId, m.text, { parse_mode: "HTML", reply_markup: m.keyboard });
  await asJobs(db, (tx) =>
    tx.update(schema.gameNights).set({ telegramMessageId: sent.message_id }).where(eq(schema.gameNights.id, nightId)),
  );
}

export interface ReminderOptions {
  now?: Date;
  /** Remind a game night this long before it starts. */
  nightLeadMs?: number;
  /** First private reminder to a debtor after this many days (a home can set settings.debtReminderDays). */
  debtDays?: number;
  /** Repeat debt reminders at most this often, and at most this many times. */
  debtRepeatDays?: number;
  debtMaxReminders?: number;
}

/**
 * Periodic job (cron → /api/cron/tick): game-night reminders to the group and to those who
 * said yes or maybe, and private reminders to debtors (never in the group).
 */
export async function runReminders(db: Db, api: Api, opts: ReminderOptions = {}) {
  const now = opts.now ?? new Date();
  const lead = opts.nightLeadMs ?? 3 * 3600e3;
  const sent = { nights: 0, debts: 0 };

  // Game nights starting within the lead time that were not reminded yet.
  const nights = await asJobs(db, (tx) =>
    tx
      .select({ night: schema.gameNights, home: schema.homes })
      .from(schema.gameNights)
      .innerJoin(schema.homes, eq(schema.homes.id, schema.gameNights.homeId))
      .where(
        and(
          isNull(schema.gameNights.canceledAt),
          isNull(schema.gameNights.remindedAt),
          gt(schema.gameNights.startsAt, now),
          lte(schema.gameNights.startsAt, new Date(now.getTime() + lead)),
        ),
      ),
  );
  for (const { night, home } of nights) {
    const coming = await asJobs(db, (tx) =>
      tx
        .select({ tg: schema.users.telegramId, locale: schema.users.locale })
        .from(schema.nightRsvps)
        .innerJoin(schema.users, eq(schema.users.id, schema.nightRsvps.userId))
        .where(and(eq(schema.nightRsvps.nightId, night.id), sql`${schema.nightRsvps.answer} IN ('yes', 'maybe')`)),
    );
    const text = (locale: string) =>
      esc(botT(locale)("nightReminder", { when: formatDate(night.startsAt, locale, true), home: home.name }));
    if (home.telegramChatId) await api.sendMessage(home.telegramChatId, text(home.locale), { parse_mode: "HTML" }).catch(() => {});
    for (const c of coming) if (c.tg) await api.sendMessage(c.tg, text(c.locale), { parse_mode: "HTML" }).catch(() => {});
    await asJobs(db, (tx) => tx.update(schema.gameNights).set({ remindedAt: now }).where(eq(schema.gameNights.id, night.id)));
    sent.nights++;
  }

  // Open debts older than the home's threshold, to the debtor privately.
  const defaultDays = opts.debtDays ?? 3;
  const repeatMs = (opts.debtRepeatDays ?? 7) * 864e5;
  const maxReminders = opts.debtMaxReminders ?? 3;
  const debts = await asJobs(db, (tx) =>
    tx
      .select({
        settlementId: schema.settlements.id,
        amount: schema.settlements.amount,
        number: schema.games.number,
        closedAt: schema.games.closedAt,
        home: schema.homes,
        to: sql<string>`(SELECT display_name FROM players WHERE id = ${schema.settlements.toPlayer})`,
        debtorTg: schema.users.telegramId,
        debtorLocale: schema.users.locale,
        count: sql<number>`(SELECT count(*) FROM debt_reminders r WHERE r.settlement_id = ${schema.settlements.id})`.mapWith(Number),
        last: sql<Date | null>`(SELECT max(sent_at) FROM debt_reminders r WHERE r.settlement_id = ${schema.settlements.id})`,
      })
      .from(schema.settlements)
      .innerJoin(schema.games, eq(schema.games.id, schema.settlements.gameId))
      .innerJoin(schema.homes, eq(schema.homes.id, schema.games.homeId))
      .innerJoin(schema.players, eq(schema.players.id, schema.settlements.fromPlayer))
      .innerJoin(schema.users, eq(schema.users.id, schema.players.userId))
      .where(
        and(
          eq(schema.games.status, "closed"),
          isNull(schema.homes.deletedAt),
          sql`NOT EXISTS (SELECT 1 FROM debt_payments p WHERE p.settlement_id = ${schema.settlements.id})`,
          lt(schema.games.closedAt, new Date(now.getTime() - 864e5)),
        ),
      ),
  );
  for (const d of debts) {
    const days = Number((d.home.settings as { debtReminderDays?: number })?.debtReminderDays ?? defaultDays);
    if (!d.debtorTg || !(days > 0)) continue;
    if (d.closedAt!.getTime() > now.getTime() - days * 864e5) continue;
    if (d.count >= maxReminders) continue;
    if (d.last && new Date(d.last).getTime() > now.getTime() - repeatMs) continue;
    const t = botT(d.debtorLocale);
    const text = t("debtReminder", {
      to: d.to,
      amount: formatAmount(d.amount, d.home, d.debtorLocale),
      number: new Intl.NumberFormat(d.debtorLocale).format(d.number!),
      home: d.home.name,
    });
    await api.sendMessage(d.debtorTg, esc(text), { parse_mode: "HTML" }).catch(() => {});
    await asJobs(db, (tx) => tx.insert(schema.debtReminders).values({ settlementId: d.settlementId, sentAt: now }));
    sent.debts++;
  }
  return sent;
}
