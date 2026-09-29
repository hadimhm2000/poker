import "server-only";
import type { ResultRow } from "@poker/domain";
import { homeStats } from "@poker/domain";
import ExcelJS from "exceljs";
import { getTranslations } from "next-intl/server";
import { dir } from "@/i18n/routing";
import { type HomeMoney, formatDate } from "./format";

/** Spreadsheet cells that start with these are treated as formulas by Excel (CSV injection). */
const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

function numFmt(home: HomeMoney) {
  const decimals = home.unitDivisor > 1 ? ".##" : "";
  const suffix = home.unitSuffix ? `"${home.unitSuffix.replace(/"/g, "")}"` : "";
  return `#,##0${decimals}${suffix};-#,##0${decimals}${suffix}`;
}

/** Two sheets shaped like the original workbook: history (sheet 2) and statistics (sheet 3). */
export async function buildWorkbook(home: HomeMoney & { name: string; locale: string }, rows: ResultRow[]) {
  const locale = home.locale;
  const t = await getTranslations({ locale, namespace: "stats" });
  const th = await getTranslations({ locale, namespace: "history" });
  const tg = await getTranslations({ locale, namespace: "game" });
  const s = homeStats(rows);
  const v = (n: number) => n / home.unitDivisor;
  const fmt = numFmt(home);
  const rtl = dir(locale) === "rtl";

  const wb = new ExcelJS.Workbook();
  wb.creator = "Poker Home";
  wb.created = new Date();

  const hist = wb.addWorksheet(th("title"), { views: [{ rightToLeft: rtl, state: "frozen", ySplit: 1 }] });
  hist.columns = [
    { header: th("date"), key: "date", width: 16 },
    { header: "#", key: "number", width: 8 },
    { header: tg("player"), key: "player", width: 18 },
    { header: tg("in"), key: "in", width: 14, style: { numFmt: fmt } },
    { header: tg("cashOut"), key: "out", width: 14, style: { numFmt: fmt } },
    { header: tg("net"), key: "net", width: 14, style: { numFmt: fmt } },
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

  const st = wb.addWorksheet(t("title"), { views: [{ rightToLeft: rtl }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 } });
  st.addRow([`${t("title")} · ${safeText(home.name)}`]).font = { bold: true, size: 14 };
  st.addRow([]);
  st.addRow([t("games"), s.totals.games, t("players"), s.totals.players]);
  const totals = st.addRow([t("moneyIn"), v(s.totals.moneyIn), t("biggestPot"), v(s.totals.biggestPot), t("averagePot"), v(s.totals.averagePot)]);
  [2, 4, 6].forEach((c) => (totals.getCell(c).numFmt = fmt));
  st.addRow([]);
  st.addRow([t("leaderboard")]).font = { bold: true };
  const head = st.addRow(["", t("player"), t("played"), t("wins"), t("winRate"), t("net"), t("average"), t("best"), t("worst")]);
  head.font = { bold: true };
  const medal = ["", "🥇", "🥈", "🥉"];
  for (const p of s.leaderboard) {
    const row = st.addRow([medal[p.medal ?? 0], safeText(p.name), p.games, p.wins, p.winRate, v(p.net), v(p.average), v(p.best), v(p.worst)]);
    row.getCell(5).numFmt = "0%";
    [6, 7, 8, 9].forEach((c) => (row.getCell(c).numFmt = fmt));
    row.getCell(6).font = { bold: true, color: { argb: p.net >= 0 ? "FF0F7A3D" : "FFB3261E" } };
  }
  st.addRow([]);
  st.addRow([t("lastGames", { count: s.lastGames.length })]).font = { bold: true };
  st.addRow(["#", t("date"), t("pot"), t("topWinner"), "", t("topLoser"), ""]).font = { bold: true };
  for (const g of s.lastGames) {
    const row = st.addRow([
      g.number,
      formatDate(g.closedAt, locale),
      v(g.pot),
      g.topWinner ? safeText(g.topWinner.name) : "",
      g.topWinner ? v(g.topWinner.net) : "",
      g.topLoser ? safeText(g.topLoser.name) : "",
      g.topLoser ? v(g.topLoser.net) : "",
    ]);
    [3, 5, 7].forEach((c) => (row.getCell(c).numFmt = fmt));
  }
  st.addRow([]);
  st.addRow([t("records")]).font = { bold: true };
  const r = s.records;
  const rec: [string, string, number | string, boolean][] = [];
  if (r.biggestWin) rec.push([t("biggestWin"), r.biggestWin.name, v(r.biggestWin.value), true]);
  if (r.biggestLoss) rec.push([t("biggestLoss"), r.biggestLoss.name, v(r.biggestLoss.value), true]);
  if (r.longestWinStreak) rec.push([t("longestWinStreak"), r.longestWinStreak.name, r.longestWinStreak.value, false]);
  if (r.longestLossStreak) rec.push([t("longestLossStreak"), r.longestLossStreak.name, r.longestLossStreak.value, false]);
  if (r.mostGames) rec.push([t("mostGames"), r.mostGames.name, r.mostGames.value, false]);
  if (r.bestAverage) rec.push([t("bestAverage"), r.bestAverage.name, v(r.bestAverage.value), true]);
  for (const [label, name, value, isMoney] of rec) {
    const row = st.addRow([label, safeText(name), value]);
    if (isMoney) row.getCell(3).numFmt = fmt;
  }
  st.getColumn(1).width = 22;
  st.getColumn(2).width = 18;
  for (let c = 3; c <= 9; c++) st.getColumn(c).width = 13;

  return Buffer.from(await wb.xlsx.writeBuffer());
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
