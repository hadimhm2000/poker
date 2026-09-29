// Turns a spreadsheet (already read into rows of cells) into games ready to import.
// Pure functions: no I/O, fully unit-tested.
import { normalizeDigits } from "./format";

export type Cell = string | number | Date | null | undefined;

export interface ParsedRow {
  name: string;
  totalIn: number;
  cashOut: number;
}

export interface ParsedGame {
  key: string;
  /** ISO date (yyyy-mm-dd) the game was played */
  date: string;
  number: number | null;
  rows: ParsedRow[];
  status: "ok" | "unbalanced" | "tooFew" | "duplicateInFile" | "duplicate" | "duplicatePlayer";
  difference: number;
}

export interface ParseResult {
  columns: Partial<Record<Column, string>>;
  games: ParsedGame[];
  error: "noColumns" | null;
}

type Column = "date" | "number" | "player" | "in" | "out" | "net";

// Header words in all seven languages. Matched after lower-casing and removing spaces.
const SYNONYMS: Record<Column, string[]> = {
  date: ["date", "تاریخ", "التاريخ", "تاريخ", "data", "fecha", "дата", "day", "روز"],
  number: ["#", "game", "no", "number", "شماره", "بازی", "رقم", "لعبة", "partita", "partie", "игра", "№", "partida", "gameno"],
  player: ["player", "name", "بازیکن", "اسم", "نام", "لاعب", "اللاعب", "joueur", "nom", "giocatore", "nome", "jugador", "nombre", "игрок", "имя"],
  in: ["in", "buyin", "buy-in", "ورودی", "ورود", "خرید", "دخول", "entrée", "entree", "cave", "entrata", "entrada", "вход", "байин", "бай-ин"],
  out: ["out", "cashout", "cash-out", "خروجی", "خروج", "نقد", "sortie", "uscita", "salida", "кэшаут", "кэш-аут", "выход"],
  net: ["net", "profit", "result", "p/l", "pnl", "سود", "سود/زیان", "نتیجه", "برد/باخت", "صافي", "الصافي", "résultat", "resultat", "netto", "neto", "итог", "результат"],
};

const norm = (s: string) => normalizeDigits(s).toLowerCase().replace(/[\s_]/g, "");

export function detectColumns(header: Cell[]): Partial<Record<Column, number>> {
  const found: Partial<Record<Column, number>> = {};
  const cells = header.map((c) => norm(String(c ?? "")));
  // Exact matches first, then "contains", so "cash-out" is not taken for "in".
  for (const pass of ["exact", "contains"] as const) {
    cells.forEach((c, i) => {
      if (!c || Object.values(found).includes(i)) return;
      for (const col of Object.keys(SYNONYMS) as Column[]) {
        if (found[col] !== undefined) continue;
        const hit = SYNONYMS[col].some((w) => {
          const n = norm(w);
          return pass === "exact" ? c === n : n.length > 2 && c.includes(n);
        });
        if (hit) {
          found[col] = i;
          break;
        }
      }
    });
  }
  return found;
}

/** Solar Hijri (Jalali) to Gregorian, for Persian sheets (e.g. 1403/05/12). */
export function jalaliToGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  while (gm <= 12 && gd > monthDays[gm]!) gd -= monthDays[gm++]!;
  return [gy, gm, gd];
}

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function parseDate(cell: Cell): string | null {
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) return cell.toISOString().slice(0, 10);
  if (typeof cell === "number" && cell > 20000 && cell < 80000) {
    // Excel serial date
    return new Date(Math.round((cell - 25569) * 864e5)).toISOString().slice(0, 10);
  }
  if (typeof cell !== "string") return null;
  const s = normalizeDigits(cell.trim()).replace(/[.]/g, "/").replace(/-/g, "/");
  let m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (y < 1500) return iso(...jalaliToGregorian(y, mo, d));
    return iso(y, mo, d);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y < 1500 ? iso(...jalaliToGregorian(y, mo, d)) : iso(y, mo, d);
  }
  return null;
}

/** A money cell in display units (e.g. "2,980k" or 2980) → stored integer. */
export function parseMoney(cell: Cell, divisor: number): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? Math.round(cell * divisor) : null;
  if (typeof cell !== "string") return null;
  let s = normalizeDigits(cell.trim()).replace(/[−–]/g, "-");
  s = s.replace(/^\+/, "").replace(/[^\d.\-]+$/u, "").replace(/^[^\d.\-]+/u, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * divisor);
}

export interface ExistingGame {
  date: string;
  results: { name: string; net: number }[];
}

const signature = (date: string, results: { name: string; net: number }[]) =>
  `${date}|${results
    .map((r) => `${r.name.trim().toLowerCase()}:${r.net}`)
    .sort()
    .join(",")}`;

export function parseSheet(table: Cell[][], divisor: number, existing: ExistingGame[] = []): ParseResult {
  // The header is the first row (within the first 10) that has date, player and an amount.
  let headerAt = -1;
  let cols: Partial<Record<Column, number>> = {};
  for (let i = 0; i < Math.min(10, table.length); i++) {
    const c = detectColumns(table[i] ?? []);
    if (c.date !== undefined && c.player !== undefined && (c.net !== undefined || (c.in !== undefined && c.out !== undefined))) {
      headerAt = i;
      cols = c;
      break;
    }
  }
  if (headerAt < 0) return { columns: {}, games: [], error: "noColumns" };
  const header = table[headerAt]!;
  const columns = Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, String(header[i!] ?? "")])) as ParseResult["columns"];

  const groups = new Map<string, { date: string; number: number | null; rows: ParsedRow[] }>();
  let lastDate: string | null = null;
  let lastNumber: number | null = null;
  for (const row of table.slice(headerAt + 1)) {
    const name = String(row[cols.player!] ?? "").trim();
    if (!name) continue;
    // Merged cells in the source leave date/number blank on follow-up rows of the same game.
    const date: string | null = parseDate(row[cols.date!]) ?? lastDate;
    if (!date) continue;
    const rawNumber = cols.number !== undefined ? parseMoney(row[cols.number], 1) : null;
    const number: number | null = rawNumber ?? (cols.number !== undefined && date === lastDate ? lastNumber : null);
    lastDate = date;
    lastNumber = number;

    const inV = cols.in !== undefined ? parseMoney(row[cols.in], divisor) : null;
    const outV = cols.out !== undefined ? parseMoney(row[cols.out], divisor) : null;
    const netV = cols.net !== undefined ? parseMoney(row[cols.net], divisor) : null;
    let totalIn: number;
    let cashOut: number;
    if (inV !== null && outV !== null) [totalIn, cashOut] = [inV, outV];
    else if (inV !== null && netV !== null) [totalIn, cashOut] = [inV, inV + netV];
    else if (netV !== null) [totalIn, cashOut] = [Math.max(-netV, 0), Math.max(netV, 0)];
    else continue;
    if (totalIn < 0 || cashOut < 0) continue;

    const key = number !== null ? `n${number}` : `d${date}`;
    const g = groups.get(key) ?? { date, number, rows: [] as ParsedRow[] };
    g.rows.push({ name: name.slice(0, 40), totalIn, cashOut });
    groups.set(key, g);
  }

  const known = new Set(existing.map((e) => signature(e.date, e.results)));
  const seen = new Set<string>();
  const games: ParsedGame[] = [...groups.entries()].map(([key, g]) => {
    const sumIn = g.rows.reduce((a, r) => a + r.totalIn, 0);
    const sumOut = g.rows.reduce((a, r) => a + r.cashOut, 0);
    const sig = signature(g.date, g.rows.map((r) => ({ name: r.name, net: r.cashOut - r.totalIn })));
    const names = g.rows.map((r) => r.name.toLowerCase());
    let status: ParsedGame["status"] = "ok";
    if (g.rows.length < 2) status = "tooFew";
    else if (new Set(names).size !== names.length) status = "duplicatePlayer";
    else if (sumIn !== sumOut) status = "unbalanced";
    else if (known.has(sig)) status = "duplicate";
    else if (seen.has(sig)) status = "duplicateInFile";
    seen.add(sig);
    return { key, ...g, status, difference: sumOut - sumIn };
  });
  games.sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? 0) - (b.number ?? 0));
  return { columns, games, error: null };
}
