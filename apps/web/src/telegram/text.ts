// Message builders shared by bot commands (run as the Telegram user, under RLS) and
// automatic posts (run as the jobs role). Same queries either way; RLS decides what is seen.
import { homeStats } from "@poker/domain";
import { type Tx, ledger, nightAnswers, resultRows, schema } from "@poker/db";
import { and, desc, eq } from "@poker/db";
import { InlineKeyboard } from "grammy";
import { type HomeMoney, formatAmount, formatDate } from "@/lib/format";
import { type BotT, esc } from "./i18n";

export type Home = typeof schema.homes.$inferSelect;
const money = (home: HomeMoney, locale: string) => (n: number, signed = false) => formatAmount(n, home, locale, signed);
const MEDALS = ["🥇 ", "🥈 ", "🥉 "];

async function playerNames(tx: Tx, homeId: string) {
  const rows = await tx
    .select({ id: schema.players.id, name: schema.players.displayName })
    .from(schema.players)
    .where(eq(schema.players.homeId, homeId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Result of a closed game with its settlement: /last and the automatic post on close. */
export async function gameResultText(tx: Tx, home: Home, gameId: string, t: BotT, appUrl: string) {
  const m = money(home, home.locale);
  const [game] = await tx.select().from(schema.games).where(eq(schema.games.id, gameId));
  if (!game || game.status !== "closed") return null;
  const names = await playerNames(tx, home.id);
  const entries = await tx.select().from(schema.gameEntries).where(eq(schema.gameEntries.gameId, gameId));
  const transfers = await tx.select().from(schema.settlements).where(eq(schema.settlements.gameId, gameId));
  const rows = entries
    .map((e) => ({ name: names.get(e.playerId) ?? "?", net: (e.cashOut ?? 0) - e.totalIn }))
    .sort((a, b) => b.net - a.net);
  const lines = [
    `<b>${esc(t("closedTitle", { home: home.name, number: new Intl.NumberFormat(home.locale).format(game.number!) }))}</b>`,
    esc(formatDate(game.closedAt!, home.locale, true)),
    "",
    ...rows.map((r) => `${r.net > 0 ? "🟢" : r.net < 0 ? "🔴" : "⚪"} ${esc(r.name)}: <b>${esc(m(r.net, true))}</b>`),
    "",
    `<b>${esc(t("settlementTitle"))}</b>`,
    ...(transfers.length
      ? transfers.map((s) =>
          esc(t("pays", { from: names.get(s.fromPlayer) ?? "?", to: names.get(s.toPlayer) ?? "?", amount: m(s.amount) })),
        )
      : [esc(t("nothingToSettle"))]),
    "",
    `<i>${esc(t("verify", { hash: game.hash!.slice(0, 16) }))}</i>`,
  ];
  const keyboard = new InlineKeyboard().url(t("openGame"), `${appUrl}/${home.locale}/games/${game.id}`);
  return { text: lines.join("\n"), keyboard };
}

export async function lastGameText(tx: Tx, home: Home, t: BotT, appUrl: string) {
  const [g] = await tx
    .select({ id: schema.games.id })
    .from(schema.games)
    .where(and(eq(schema.games.homeId, home.id), eq(schema.games.status, "closed")))
    .orderBy(desc(schema.games.number))
    .limit(1);
  return g ? gameResultText(tx, home, g.id, t, appUrl) : null;
}

/** /stats and /stats <name>. */
export async function statsText(tx: Tx, home: Home, t: BotT, who?: string) {
  const m = money(home, home.locale);
  const stats = homeStats(await resultRows(tx, home.id));
  if (!stats.totals.games) return esc(t("noGames"));
  if (who) {
    const q = who.trim().toLowerCase();
    const p =
      stats.leaderboard.find((x) => x.name.toLowerCase() === q) ?? stats.leaderboard.find((x) => x.name.toLowerCase().includes(q));
    if (!p) return esc(t("playerNotFound", { name: who }));
    return esc(
      t("playerStats", {
        name: p.name,
        net: m(p.net, true),
        games: p.games,
        wins: p.wins,
        best: m(p.best, true),
        worst: m(p.worst, true),
      }),
    );
  }
  return [
    `<b>${esc(t("statsTitle", { home: home.name, games: stats.totals.games }))}</b>`,
    ...stats.leaderboard
      .slice(0, 15)
      .map((p, i) => `${MEDALS[i] ?? `${i + 1}. `}${esc(p.name)}: <b>${esc(m(p.net, true))}</b> (${esc(t("gamesCount", { games: p.games }))})`),
  ].join("\n");
}

/** /debts: open debts with a "paid" button each (the database decides who may press it). */
export async function debtsText(tx: Tx, home: Home, t: BotT) {
  const m = money(home, home.locale);
  const names = await playerNames(tx, home.id);
  const debts = await ledger(tx, home.id);
  if (!debts.length) return { text: esc(t("noDebts")), keyboard: undefined };
  const keyboard = new InlineKeyboard();
  const lines = [`<b>${esc(t("debtsTitle"))}</b>`];
  for (const d of debts.slice(0, 20)) {
    const from = names.get(d.from) ?? "?";
    const to = names.get(d.to) ?? "?";
    lines.push(esc(`#${new Intl.NumberFormat(home.locale).format(d.gameNumber ?? 0)} · ${t("pays", { from, to, amount: m(d.amount) })}`));
    keyboard.text(t("markPaid", { from, to }), `pd:${d.settlementId}`).row();
  }
  return { text: lines.join("\n"), keyboard };
}

/** A game night invite with come / maybe / can't buttons and the answers so far. */
export async function nightText(tx: Tx, home: Home, nightId: string, t: BotT) {
  const [n] = await tx.select().from(schema.gameNights).where(eq(schema.gameNights.id, nightId));
  if (!n) return null;
  const answers = await nightAnswers(tx, n.id);
  const fmt = new Intl.ListFormat(home.locale);
  const list = (a: string) => fmt.format(answers.filter((x) => x.answer === a).map((x) => x.name ?? "?")) || "—";
  const lines = [
    `<b>${esc(t("nightTitle", { date: formatDate(n.startsAt, home.locale, true) }))}</b>`,
    ...(n.place ? [esc(t("nightPlace", { place: n.place }))] : []),
    ...(n.note ? [esc(n.note)] : []),
    "",
    esc(t("nightYes", { names: list("yes") })),
    esc(t("nightMaybe", { names: list("maybe") })),
    esc(t("nightNo", { names: list("no") })),
  ];
  if (n.canceledAt) lines.unshift(`<b>${esc(t("nightCanceled"))}</b>`);
  const keyboard = n.canceledAt
    ? undefined
    : new InlineKeyboard()
        .text(t("rsvpYes"), `nv:${n.id}:y`)
        .text(t("rsvpMaybe"), `nv:${n.id}:m`)
        .text(t("rsvpNo"), `nv:${n.id}:n`);
  return { text: lines.join("\n"), keyboard };
}
