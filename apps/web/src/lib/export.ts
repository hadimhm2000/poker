import "server-only";
import type { ResultRow } from "@poker/domain";
import { formatMoney, homeStats } from "@poker/domain";
import ExcelJS from "exceljs";
import { getTranslations } from "next-intl/server";
import { dir } from "@/i18n/routing";
import { type HomeMoney, formatDate } from "./format";
import { appendCharts } from "./export-charts";

/** Spreadsheet cells that start with these are treated as formulas by Excel (CSV injection). */
const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

function numFmt(home: HomeMoney) {
  const decimals = home.unitDivisor > 1 ? ".##" : "";
  const suffix = home.unitSuffix ? `"${home.unitSuffix.replace(/"/g, "")}"` : "";
  return `#,##0${decimals}${suffix};-#,##0${decimals}${suffix}`;
}

/** Money format that colors wins green and losses red, like the reference workbook. */
function netFmt(home: HomeMoney) {
  const decimals = home.unitDivisor > 1 ? ".##" : "";
  const suffix = home.unitSuffix ? `"${home.unitSuffix.replace(/"/g, "")}"` : "";
  return `[Color10]\\+#,##0${decimals}${suffix};[Red]\\-#,##0${decimals}${suffix};0${decimals}${suffix}`;
}

/** Always-positive money with a leading plus, for "biggest win" style values. */
function plusFmt(home: HomeMoney) {
  const decimals = home.unitDivisor > 1 ? ".##" : "";
  const suffix = home.unitSuffix ? `"${home.unitSuffix.replace(/"/g, "")}"` : "";
  return `\\+#,##0${decimals}${suffix}`;
}

const signedPctFmt = `[Color10]\\+0%;[Red]\\-0%;0%`;

// Palette of the reference workbook: dark green accents on soft green cards.
const INK = "FF1F2937";
const GRAY = "FF6B7280";
const GREEN = "FF1F5C45";
const CARD = "FFEEF4F1";
const LINE = "FFE5E7EB";
const ZEBRA = "FFF6F8F7";
const MEDALS = ["FFF5C542", "FFC9CED6", "FFD9A066"];
const CHART_GREEN = "2E8B57";
const CHART_RED = "D9534F";
const CHART_GRAY = "9CA3AF";

interface CellStyle {
  value?: string | number | null;
  font?: Partial<ExcelJS.Font>;
  fill?: { argb: string };
  numFmt?: string;
  border?: Partial<Record<"top" | "bottom", { style: ExcelJS.BorderStyle; color: { argb: string } }>>;
  alignment?: Partial<ExcelJS.Alignment>;
}

function put(ws: ExcelJS.Worksheet, row: number, col: number, style: CellStyle) {
  const cell = ws.getCell(row, col);
  if (style.value !== undefined) cell.value = style.value;
  if (style.font) cell.font = style.font as ExcelJS.Font;
  if (style.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: style.fill };
  if (style.numFmt) cell.numFmt = style.numFmt;
  if (style.border) cell.border = style.border as ExcelJS.Borders;
  if (style.alignment) cell.alignment = style.alignment as ExcelJS.Alignment;
  return cell;
}

/** Style every cell of a (possibly merged) block; the value goes to the top-left cell. */
function block(ws: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number, style: CellStyle) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      put(ws, r, c, r === r1 && c === c1 ? style : { ...style, value: undefined });
    }
  }
  if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
}

/** Current streak of a player: +N wins in a row, -N losses in a row, 0 otherwise. */
function currentStreak(points: { total: number }[]): number {
  const nets = points.map((p, i) => p.total - (i ? points[i - 1]!.total : 0));
  const last = nets[nets.length - 1];
  if (!last) return 0;
  let streak = 0;
  for (let i = nets.length - 1; i >= 0; i--) {
    if (nets[i]! === 0 || Math.sign(nets[i]!) !== Math.sign(last)) break;
    streak++;
  }
  return Math.sign(last) * streak;
}

interface SettleRow {
  from: string;
  debt: number;
  to: string;
  credit: number;
  amount: number;
  remaining: number;
}

interface Settlement {
  rows: SettleRow[];
  /** Original total debt / credit of the whole history, in smallest units. */
  totalDebt: number;
  totalCredit: number;
  /** Sum of the planned transfer amounts. */
  totalPaid: number;
  /** Non-zero only when buy-ins and cash-outs do not cancel out (data error). */
  unsettledDebt: number;
  unsettledCredit: number;
}
/**
 * Greedy netting of the whole history's balances, like the reference workbook's
 * Loser/Debt/Winner/Credit/Pay table: the biggest debt pays the biggest credit
 * until every debt and every payment is settled. Amounts stay in the home's
 * smallest unit so the arithmetic is exact.
 */
function settlementRows(players: { name: string; net: number }[]): Settlement {
  const debtors = players
    .filter((p) => p.net < 0)
    .map((p) => ({ name: p.name, remaining: -p.net }))
    .sort((a, b) => b.remaining - a.remaining);
  const creditors = players
    .filter((p) => p.net > 0)
    .map((p) => ({ name: p.name, remaining: p.net }))
    .sort((a, b) => b.remaining - a.remaining);
  const totalDebt = debtors.reduce((a, x) => a + x.remaining, 0);
  const totalCredit = creditors.reduce((a, x) => a + x.remaining, 0);
  const rows: SettleRow[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d]!;
    const creditor = creditors[c]!;
    const amount = Math.min(debtor.remaining, creditor.remaining);
    if (amount > 0) {
      rows.push({
        from: debtor.name,
        debt: debtor.remaining,
        to: creditor.name,
        credit: creditor.remaining,
        amount,
        remaining: debtor.remaining - amount,
      });
    }
    debtor.remaining -= amount;
    creditor.remaining -= amount;
    if (debtor.remaining === 0) d++;
    if (creditor.remaining === 0) c++;
  }
  const totalPaid = rows.reduce((a, r) => a + r.amount, 0);
  const unsettledDebt = debtors.reduce((a, x) => a + x.remaining, 0);
  const unsettledCredit = creditors.reduce((a, x) => a + x.remaining, 0);
  return { rows, totalDebt, totalCredit, totalPaid, unsettledDebt, unsettledCredit };
}

/**
 * Two sheets shaped like the original workbook: history (sheet 2) and statistics
 * (sheet 3). The statistics sheet mirrors the reference workbook: KPI cards, a
 * leaderboard sorted by profit, charts, recent games, records, and the overall
 * settlement ("who pays whom") of the closed games.
 */
export async function buildWorkbook(
  home: HomeMoney & { name: string; locale: string },
  rows: ResultRow[],
  opts: { gamesCount?: number } = {},
) {
  const locale = home.locale;
  const t = await getTranslations({ locale, namespace: "stats" });
  const th = await getTranslations({ locale, namespace: "history" });
  const tg = await getTranslations({ locale, namespace: "game" });
  const s = homeStats(rows, { gamesCount: opts.gamesCount });
  const v = (n: number) => n / home.unitDivisor;
  const fmt = numFmt(home);
  const netf = netFmt(home);
  const plusf = plusFmt(home);
  const rtl = dir(locale) === "rtl";
  const nameAlign = { horizontal: (rtl ? "right" : "left") as "right" | "left", vertical: "middle" as const };
  const center = { horizontal: "center" as const, vertical: "middle" as const };
  // The streak column ("W3"/"L2") in the export's language, whatever it is — never a hard-coded
  // Persian word in an Arabic or French file.
  const word = (s: string) => s.replace(/"/g, "").trim();
  const streakFmt = `[Color10]"${word(t("streakWin"))} "0;[Red]"${word(t("streakLoss"))} "0;"-"`;
  const money = (n: number, signed = false) =>
    formatMoney(n, { locale, currency: home.currency, divisor: home.unitDivisor, suffix: home.unitSuffix || undefined, signed });

  /** Explicit font for RTL locales so Persian renders everywhere (falls back safely where missing). */
  const fontName = rtl ? "Vazirmatn" : undefined;
  const applyFont = (ws: ExcelJS.Worksheet) => {
    if (!fontName) return;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = { ...(cell.font ?? {}), name: fontName };
      });
    });
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = "Poker Home";
  wb.created = new Date();

  /** ExcelJS protects some sheet names (e.g. "History" in English); fall back gracefully. */
  const addSheet = (name: string, opts: Partial<ExcelJS.AddWorksheetOptions>) => {
    const options = opts as ExcelJS.AddWorksheetOptions;
    try {
      return wb.addWorksheet(name, options);
    } catch {
      return wb.addWorksheet(`${name} log`, options);
    }
  };

  const hist = addSheet(th("title"), { views: [{ rightToLeft: rtl, state: "frozen", ySplit: 1 }] });
  hist.columns = [
    { header: th("date"), key: "date", width: 16 },
    { header: "#", key: "number", width: 8 },
    { header: tg("player"), key: "player", width: 18 },
    { header: tg("in"), key: "in", width: 14, style: { numFmt: fmt } },
    { header: tg("cashOut"), key: "out", width: 14, style: { numFmt: fmt } },
    { header: tg("net"), key: "net", width: 14, style: { numFmt: netf } },
  ];
  hist.getRow(1).font = { bold: true };
  for (const r of [...rows].reverse()) {
    const row = hist.addRow({
      date: formatDate(r.closedAt, locale),
      number: r.number,
      player: safeText(r.name),
      in: v(r.totalIn),
      out: v(r.cashOut),
      net: v(r.cashOut - r.totalIn),
    });
    const n = r.cashOut - r.totalIn;
    if (n) row.getCell("net").font = { color: { argb: n > 0 ? "FF0F7A3D" : "FFB3261E" } };
  }
  hist.autoFilter = { from: "A1", to: "F1" };
  applyFont(hist);

  // ---- Statistics sheet (mirrors the reference workbook's Sheet3 design) ----
  const st = addSheet(t("title"), {
    views: [{ rightToLeft: rtl, showGridLines: false }],
    properties: { tabColor: { argb: GREEN } },
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const widths: Record<number, number> = { 1: 2, 2: 6, 3: 14, 4: 8, 5: 7, 6: 8, 7: 11, 8: 12, 9: 8, 10: 12, 11: 11, 12: 9, 13: 9, 14: 10, 15: 12, 16: 3 };
  for (const [c, w] of Object.entries(widths)) st.getColumn(Number(c)).width = w;

  // Title + subtitle.
  const sheetName = st.name;
  put(st, 1, 2, { value: `${sheetName} · ${safeText(home.name)}`, font: { size: 20, bold: true, color: { argb: INK } } });
  st.getRow(1).height = 30;
  put(st, 2, 2, { value: t("sheetSubtitle"), font: { size: 10, color: { argb: GRAY } } });

  // Single best/worst rows, needed for the KPI captions.
  let bigWin: ResultRow | null = null;
  let bigLoss: ResultRow | null = null;
  for (const r of rows) {
    const n = r.cashOut - r.totalIn;
    if (!bigWin || n > bigWin.cashOut - bigWin.totalIn) bigWin = r;
    if (!bigLoss || n < bigLoss.cashOut - bigLoss.totalIn) bigLoss = r;
  }
  const nights = new Set(s.games.map((g) => g.closedAt.toISOString().slice(0, 10))).size;
  const top = s.leaderboard[0];
  const lastGame = s.lastGames[0];

  // KPI cards.
  const cards: { label: string; value: string | number; numFmt?: string; caption: string }[] = [
    { label: t("games"), value: s.totals.games, caption: t("savedGames") },
    {
      label: t("gameNights"),
      value: nights,
      caption: t("since", { date: s.games.length ? formatDate(s.games[0]!.closedAt, locale) : "-" }),
    },
    { label: t("players"), value: s.totals.players, caption: t("allTime") },
    { label: t("moneyPlayed"), value: v(s.totals.moneyIn), numFmt: fmt, caption: t("totalBuyIns") },
    {
      label: t("topPlayer"),
      value: top ? safeText(top.name) : "-",
      caption: top ? t("profitOf", { amount: money(top.net, true) }) : "-",
    },
    {
      label: t("biggestWin"),
      value: bigWin ? v(bigWin.cashOut - bigWin.totalIn) : 0,
      numFmt: plusf,
      caption: bigWin ? `${safeText(bigWin.name)} — ${formatDate(bigWin.closedAt, locale)}` : "-",
    },
    {
      label: t("lastGame"),
      value: lastGame ? formatDate(lastGame.closedAt, locale) : "-",
      caption: lastGame ? t("gameNumber", { number: lastGame.number }) : "-",
    },
  ];
  cards.forEach((card, i) => {
    const c1 = 2 + i * 2;
    const c2 = c1 + 1;
    block(st, 4, c1, 4, c2, {
      value: card.label,
      font: { size: 9, bold: true, color: { argb: GREEN } },
      fill: { argb: CARD },
      border: { top: { style: "medium", color: { argb: GREEN } } },
      alignment: center,
    });
    block(st, 5, c1, 5, c2, {
      value: card.value,
      font: { size: 16, bold: true, color: { argb: INK } },
      fill: { argb: CARD },
      numFmt: card.numFmt,
      alignment: center,
    });
    block(st, 6, c1, 6, c2, {
      value: card.caption,
      font: { size: 8, color: { argb: GRAY } },
      fill: { argb: CARD },
      alignment: center,
    });
  });
  st.getRow(5).height = 26.1;

  // Leaderboard: #, player, games, wins, win %, total in, net, ROI, averages, extremes, streak, last played.
  const HEAD = 7;
  const boardHeaders = [
    "#",
    t("player"),
    t("played"),
    t("wins"),
    t("winRate"),
    t("totalInCol"),
    t("net"),
    t("roi"),
    t("avgProfit"),
    t("avgBuyIn"),
    t("biggestWin"),
    t("biggestLoss"),
    t("streak"),
    t("lastPlayed"),
  ];
  boardHeaders.forEach((h, i) =>
    put(st, HEAD, 2 + i, {
      value: h,
      font: { bold: true, color: { argb: "FFFFFFFF" } },
      fill: { argb: GREEN },
      alignment: center,
    }),
  );
  st.getRow(HEAD).height = 30;

  const streakOf = new Map(s.cumulative.map((c) => [c.playerId, currentStreak(c.points)]));
  const lastPlayedOf = new Map(
    s.cumulative.map((c) => {
      const last = c.points[c.points.length - 1];
      return [c.playerId, last ? formatDate(last.closedAt, locale) : "-"];
    }),
  );
  s.leaderboard.forEach((p, i) => {
    const r = HEAD + 1 + i;
    const zebra = r % 2 === 0 ? { argb: ZEBRA } : undefined;
    const cells: CellStyle[] = [
      { value: i + 1, numFmt: "0", alignment: center, font: i < 3 ? { bold: true } : undefined, fill: i < 3 ? { argb: MEDALS[i]! } : zebra },
      { value: safeText(p.name), font: { bold: true, color: { argb: INK } }, alignment: nameAlign, fill: zebra },
      { value: p.games, numFmt: "0", alignment: center, fill: zebra },
      { value: p.wins, numFmt: "0", alignment: center, fill: zebra },
      { value: p.winRate, numFmt: "0%", alignment: center, fill: zebra },
      { value: v(p.totalIn), numFmt: fmt, alignment: center, fill: zebra },
      { value: v(p.net), numFmt: netf, alignment: center, font: { bold: true, color: { argb: INK } }, fill: zebra },
      { value: p.totalIn ? p.net / p.totalIn : 0, numFmt: signedPctFmt, alignment: center, fill: zebra },
      { value: v(p.average), numFmt: fmt, alignment: center, fill: zebra },
      { value: p.games ? v(p.totalIn / p.games) : 0, numFmt: fmt, alignment: center, fill: zebra },
      { value: v(p.best), numFmt: plusf, alignment: center, fill: zebra },
      { value: v(p.worst), numFmt: netf, alignment: center, fill: zebra },
      { value: streakOf.get(p.playerId) ?? 0, numFmt: streakFmt, alignment: center, fill: zebra },
      { value: lastPlayedOf.get(p.playerId) ?? "-", alignment: center, fill: zebra },
    ];
    cells.forEach((style, c) => put(st, r, 2 + c, style));
    st.getRow(r).height = 15.95;
  });

  if (s.games.length === 0) {
    put(st, HEAD + 2, 2, { value: t("empty"), font: { size: 10, italic: true, color: { argb: GRAY } } });
    applyFont(st);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ---- Charts, recent games, records ----
  const N = s.leaderboard.length;
  const SECTION_R = HEAD + N + 2;
  put(st, SECTION_R, 2, { value: t("chartsGamesRecords"), font: { size: 16, bold: true, color: { argb: INK } } });
  st.getRow(SECTION_R).height = 26;

  // Last games table (right half, under the KPI cards).
  const GAMES_TITLE_R = SECTION_R + 2;
  put(st, GAMES_TITLE_R, 10, { value: t("lastGames", { count: s.lastGames.length }), font: { size: 13, bold: true, color: { argb: GREEN } } });
  const gameHeaders = ["#", t("date"), t("playersInGame"), t("pot"), t("winner"), t("won")];
  gameHeaders.forEach((h, i) =>
    put(st, GAMES_TITLE_R + 1, 10 + i, {
      value: h,
      font: { size: 10, bold: true, color: { argb: "FFFFFFFF" } },
      fill: { argb: GREEN },
      alignment: center,
    }),
  );
  s.lastGames.forEach((g, i) => {
    const r = GAMES_TITLE_R + 2 + i;
    const border = { bottom: { style: "thin" as const, color: { argb: LINE } } };
    const cells: CellStyle[] = [
      { value: g.number, numFmt: '"#"0', alignment: center, border },
      { value: formatDate(g.closedAt, locale), alignment: center, border },
      { value: g.players, numFmt: "0", alignment: center, border },
      { value: v(g.pot), numFmt: fmt, alignment: center, border },
      { value: g.topWinner ? safeText(g.topWinner.name) : "-", font: { bold: true, color: { argb: INK } }, alignment: center, border },
      { value: g.topWinner ? v(g.topWinner.net) : 0, numFmt: netf, alignment: center, border },
    ];
    cells.forEach((style, c) => put(st, r, 10 + c, style));
    st.getRow(r).height = 18;
  });

  // Records (right half, below the recent games).
  const RECORDS_TITLE_R = GAMES_TITLE_R + 15;
  put(st, RECORDS_TITLE_R, 10, { value: t("records"), font: { size: 13, bold: true, color: { argb: GREEN } } });
  const regulars = s.leaderboard.filter((p) => p.games >= 5);
  const bestRate = regulars.reduce<typeof s.leaderboard[number] | null>((a, b) => (!a || b.winRate > a.winRate ? b : a), null);
  const bestRoi = regulars.reduce<typeof s.leaderboard[number] | null>(
    (a, b) => (!a || (b.totalIn ? b.net / b.totalIn : 0) > (a.totalIn ? a.net / a.totalIn : 0) ? b : a),
    null,
  );
  const hottest = [...streakOf.entries()].reduce<{ name: string; streak: number } | null>((a, [playerId, streak]) => {
    if (streak <= 0) return a;
    const p = s.leaderboard.find((x) => x.playerId === playerId);
    return !a || streak > a.streak ? { name: p?.name ?? playerId, streak } : a;
  }, null);
  const bigPot = s.games.reduce((a, b) => (b.pot > a.pot ? b : a), s.games[0]!);
  const records: string[] = [
    s.records.mostGames ? `${safeText(s.records.mostGames.name)} (${t("gamesPlayed", { count: s.records.mostGames.value })})` : "-",
    bestRate ? `${safeText(bestRate.name)} (${Math.round(bestRate.winRate * 100)}%)` : "-",
    bestRoi ? `${safeText(bestRoi.name)} (${bestRoi.totalIn && bestRoi.net > 0 ? "+" : ""}${Math.round((bestRoi.totalIn ? bestRoi.net / bestRoi.totalIn : 0) * 100)}%)` : "-",
    hottest ? `${safeText(hottest.name)} (${t("streakWins", { count: hottest.streak })})` : "-",
    `${money(bigPot.pot)} (${t("gameNumber", { number: bigPot.number })})`,
    bigLoss ? `${money(bigLoss.cashOut - bigLoss.totalIn, true)} — ${safeText(bigLoss.name)} — ${formatDate(bigLoss.closedAt, locale)}` : "-",
    money(s.totals.averagePot),
    (rows.length / s.totals.games).toFixed(1),
  ];
  const recordLabels = [
    t("mostGamesPlayed"),
    t("bestWinRate"),
    t("bestRoi"),
    t("hottestStreak"),
    t("biggestPotGame"),
    t("biggestSingleLoss"),
    t("avgPotGame"),
    t("avgPlayersGame"),
  ];
  recordLabels.forEach((label, i) => {
    const r = RECORDS_TITLE_R + 1 + i;
    const fill = { argb: i % 2 === 0 ? CARD : "FFFFFFFF" };
    block(st, r, 10, r, 12, {
      value: label,
      font: { size: 10, color: { argb: GRAY } },
      fill,
      border: i === 0 ? { top: { style: "medium", color: { argb: GREEN } } } : undefined,
      alignment: nameAlign,
    });
    block(st, r, 13, r, 15, { value: records[i], font: { size: 10, bold: true, color: { argb: INK } }, fill, alignment: nameAlign });
    st.getRow(r).height = 18;
  });

  // ---- Overall result: settlement of the whole history ----
  const settle = settlementRows(s.leaderboard.map((p) => ({ name: p.name, net: p.net })));
  const transfers = settle.rows;
  const balanced = settle.unsettledDebt === 0 && settle.unsettledCredit === 0;
  const SETTLE_TITLE_R = RECORDS_TITLE_R + 17;
  put(st, SETTLE_TITLE_R, 2, { value: t("settlement"), font: { size: 16, bold: true, color: { argb: INK } } });
  st.getRow(SETTLE_TITLE_R).height = 26;
  put(st, SETTLE_TITLE_R + 1, 2, { value: t("settlementNote"), font: { size: 10, color: { argb: GRAY } } });

  const SETTLE_HEAD_R = SETTLE_TITLE_R + 3;
  const groups: [number, number][] = [
    [2, 3],
    [4, 5],
    [6, 7],
    [8, 9],
    [10, 11],
    [12, 13],
    [14, 15],
  ];
  const settleHeaders = [
    t("loser"),
    t("debt"),
    t("winnerCol"),
    t("credit"),
    t("payAmount"),
    t("remainingDebt"),
    t("status"),
  ];
  groups.forEach(([c1, c2], i) =>
    block(st, SETTLE_HEAD_R, c1, SETTLE_HEAD_R, c2, {
      value: settleHeaders[i],
      font: { size: 10, bold: true, color: { argb: "FFFFFFFF" } },
      fill: { argb: GREEN },
      alignment: center,
    }),
  );
  st.getRow(SETTLE_HEAD_R).height = 20;
  transfers.forEach((tr, i) => {
    const r = SETTLE_HEAD_R + 1 + i;
    const zebra = i % 2 === 1 ? { argb: ZEBRA } : undefined;
    const border = { bottom: { style: "thin" as const, color: { argb: LINE } } };
    const values: CellStyle[] = [
      { value: safeText(tr.from), font: { size: 10, bold: true, color: { argb: INK } }, alignment: nameAlign, fill: zebra, border },
      { value: v(tr.debt), numFmt: fmt, alignment: center, fill: zebra, border },
      { value: safeText(tr.to), font: { size: 10, bold: true, color: { argb: INK } }, alignment: nameAlign, fill: zebra, border },
      { value: v(tr.credit), numFmt: fmt, alignment: center, fill: zebra, border },
      { value: v(tr.amount), numFmt: fmt, alignment: center, font: { bold: true, color: { argb: GREEN } }, fill: zebra, border },
      { value: v(tr.remaining), numFmt: fmt, alignment: center, fill: zebra, border },
      { value: t("settledRow"), font: { size: 10, bold: true, color: { argb: "FF0F7A3D" } }, alignment: center, fill: zebra, border },
    ];
    values.forEach((style, j) => {
      const [c1, c2] = groups[j]!;
      block(st, r, c1, r, c2, { ...style, border });
    });
    st.getRow(r).height = 18;
  });

  // Totals row and completion banner: prove every debt and payment is settled.
  let cursor = SETTLE_HEAD_R + 1;
  if (transfers.length === 0) {
    block(st, cursor, 2, cursor, 15, {
      value: t("settleNone"),
      font: { size: 10, italic: true, color: { argb: GRAY } },
      alignment: nameAlign,
    });
    cursor += 1;
  } else {
    cursor += transfers.length;
    const totalBorder = { top: { style: "thin" as const, color: { argb: GREEN } } };
    const totals: CellStyle[] = [
      { value: t("totalRow"), font: { size: 10, bold: true, color: { argb: INK } }, alignment: nameAlign },
      { value: v(settle.totalDebt), numFmt: fmt, alignment: center, font: { size: 10, bold: true, color: { argb: INK } } },
      { value: null, alignment: center },
      { value: v(settle.totalCredit), numFmt: fmt, alignment: center, font: { size: 10, bold: true, color: { argb: INK } } },
      { value: v(settle.totalPaid), numFmt: fmt, alignment: center, font: { size: 10, bold: true, color: { argb: GREEN } } },
      { value: v(settle.unsettledDebt), numFmt: fmt, alignment: center, font: { size: 10, bold: true, color: { argb: INK } } },
      {
        value: balanced ? t("fullySettled") : t("unbalancedShort"),
        font: { size: 10, bold: true, color: { argb: balanced ? "FF0F7A3D" : "FFB3261E" } },
        alignment: center,
      },
    ];
    totals.forEach((style, j) => {
      const [c1, c2] = groups[j]!;
      block(st, cursor, c1, cursor, c2, { ...style, fill: { argb: CARD }, border: totalBorder });
    });
    st.getRow(cursor).height = 20;
    cursor += 1;
  }
  const banner = balanced
    ? t("allSettledBanner", { count: transfers.length, amount: money(settle.totalPaid) })
    : t("unbalanced", { debt: money(settle.unsettledDebt), credit: money(settle.unsettledCredit) });
  block(st, cursor, 2, cursor, 15, {
    value: banner,
    font: { size: 11, bold: true, color: { argb: balanced ? GREEN : "FFB3261E" } },
    fill: { argb: balanced ? CARD : "FFFDECEA" },
    border: { top: { style: "medium", color: { argb: balanced ? GREEN : "FFB3261E" } } },
    alignment: nameAlign,
  });
  st.getRow(cursor).height = 22;

  // Per-player balances: pay / receive, plus everyone's state after the settlement.
  const STATUS_TITLE_R = cursor + 2;
  put(st, STATUS_TITLE_R, 2, { value: t("playerStatus"), font: { size: 13, bold: true, color: { argb: GREEN } } });
  st.getRow(STATUS_TITLE_R).height = 20;
  const statusHead = STATUS_TITLE_R + 1;
  const headCells: [number, number, string][] = [
    [2, 3, t("player")],
    [4, 6, t("account")],
    [7, 9, t("afterSettlement")],
  ];
  headCells.forEach(([c1, c2, label]) =>
    block(st, statusHead, c1, statusHead, c2, {
      value: label,
      font: { size: 10, bold: true, color: { argb: GREEN } },
      fill: { argb: CARD },
      alignment: nameAlign,
    }),
  );
  st.getRow(statusHead).height = 18;
  s.leaderboard.forEach((p, i) => {
    const r = statusHead + 1 + i;
    const fill = { argb: i % 2 === 0 ? CARD : "FFFFFFFF" };
    const status =
      p.net < 0
        ? { text: t("pay", { amount: money(-p.net) }), color: "FFB3261E" }
        : p.net > 0
          ? { text: t("receive", { amount: money(p.net) }), color: "FF0F7A3D" }
          : { text: t("settled"), color: GRAY };
    block(st, r, 2, r, 3, { value: safeText(p.name), font: { size: 10, color: { argb: GRAY } }, fill, alignment: nameAlign });
    block(st, r, 4, r, 6, { value: status.text, font: { size: 10, bold: true, color: { argb: status.color } }, fill, alignment: nameAlign });
    block(st, r, 7, r, 9, {
      value: balanced ? t("settledFinal") : t("partialFinal"),
      font: { size: 10, bold: true, color: { argb: balanced ? "FF0F7A3D" : "FFB3261E" } },
      fill,
      alignment: nameAlign,
    });
    st.getRow(r).height = 18;
  });

  // ---- Charts (injected into the package; ExcelJS cannot author them) ----
  const lastBoardRow = HEAD + N;
  const nameRef = (col: string, row: number) => `'${sheetName}'!$${col}$${row}`;
  const rangeRef = (col: string) => `'${sheetName}'!$${col}$${HEAD + 1}:$${col}$${lastBoardRow}`;
  const names = s.leaderboard.map((p) => p.name);
  applyFont(st);
  const buffer = appendCharts(Buffer.from(await wb.xlsx.writeBuffer()), sheetName, locale, [
    {
      spec: {
        title: t("netChart"),
        categoryRef: rangeRef("C"),
        categories: names,
        series: [
          {
            name: t("net"),
            nameRef: nameRef("H", HEAD),
            valueRef: rangeRef("H"),
            values: s.leaderboard.map((p) => v(p.net)),
            color: CHART_GREEN,
            negativeColor: CHART_RED,
          },
        ],
        gapWidth: 60,
      },
      anchor: { col: 1, row: GAMES_TITLE_R - 1, width: 4464000, height: 2664000 },
    },
    {
      spec: {
        title: t("inVsNet"),
        categoryRef: rangeRef("C"),
        categories: names,
        series: [
          {
            name: t("totalInCol"),
            nameRef: nameRef("G", HEAD),
            valueRef: rangeRef("G"),
            values: s.leaderboard.map((p) => v(p.totalIn)),
            color: CHART_GRAY,
          },
          {
            name: t("net"),
            nameRef: nameRef("H", HEAD),
            valueRef: rangeRef("H"),
            values: s.leaderboard.map((p) => v(p.net)),
            color: GREEN.slice(2),
            negativeColor: CHART_RED,
          },
        ],
        gapWidth: 80,
        legend: true,
      },
      anchor: { col: 1, row: RECORDS_TITLE_R - 1, width: 4464000, height: 2664000 },
    },
  ]);

  return buffer;
}

export async function buildCsv(home: HomeMoney & { locale: string }, rows: ResultRow[]) {
  const th = await getTranslations({ locale: home.locale, namespace: "history" });
  const tg = await getTranslations({ locale: home.locale, namespace: "game" });
  const cell = (x: string | number) => {
    const s = typeof x === "number" ? String(x) : safeText(x);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const v = (n: number) => n / home.unitDivisor;
  const lines = [[th("date"), "#", tg("player"), tg("in"), tg("cashOut"), tg("net")].map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.closedAt.toISOString().slice(0, 10), r.number, r.name, v(r.totalIn), v(r.cashOut), v(r.cashOut - r.totalIn)].map(cell).join(","),
    );
  }
  // BOM so Excel opens UTF-8 (Persian, Arabic, Cyrillic) correctly.
  return `﻿${lines.join("\r\n")}\r\n`;
}
