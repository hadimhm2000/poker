import type { Money } from "./money";
import type { ResultRow } from "./stats";

/**
 * Badges earned from closed games (the whole history, or one season). They are computed,
 * not stored, so they always agree with the frozen results.
 *
 *   streak    N winning games in a row (N ≥ 3)
 *   bigWin    the biggest single-game win in the period (one holder; earliest on a tie)
 *   regular   played N of the home's games in a row (N ≥ 5)
 *   comeback  running total went below zero and is now above it; value = amount recovered
 */
export type BadgeKind = "streak" | "bigWin" | "regular" | "comeback";

export interface Badge {
  kind: BadgeKind;
  playerId: string;
  name: string;
  value: number;
  /** The game that completed it, when there is one. */
  gameNumber?: number;
}

export const BADGE_THRESHOLDS = { streak: 3, regular: 5 } as const;

const net = (r: ResultRow): Money => r.cashOut - r.totalIn;

export function badges(rows: readonly ResultRow[]): Badge[] {
  // Game order, then the player's results in that order.
  const gameOrder = [...new Map(rows.map((r) => [r.gameId, r])).values()].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime() || a.number - b.number,
  );
  const gameIndex = new Map(gameOrder.map((g, i) => [g.gameId, i]));
  const byPlayer = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const list = byPlayer.get(r.playerId) ?? [];
    list.push(r);
    byPlayer.set(r.playerId, list);
  }

  const out: Badge[] = [];
  let big: { row: ResultRow; value: Money } | null = null;

  for (const [playerId, list] of byPlayer) {
    list.sort((a, b) => gameIndex.get(a.gameId)! - gameIndex.get(b.gameId)!);
    const name = list[list.length - 1]!.name;

    let run = 0;
    let bestRun = { n: 0, at: 0 };
    let attend = 0;
    let bestAttend = { n: 0, at: 0 };
    let prevIndex = -2;
    let total = 0;
    let low = 0;

    for (const r of list) {
      const n = net(r);
      run = n > 0 ? run + 1 : 0;
      if (run > bestRun.n) bestRun = { n: run, at: r.number };

      const idx = gameIndex.get(r.gameId)!;
      attend = idx === prevIndex + 1 ? attend + 1 : 1;
      prevIndex = idx;
      if (attend > bestAttend.n) bestAttend = { n: attend, at: r.number };

      total += n;
      low = Math.min(low, total);

      if (n > 0 && (!big || n > big.value)) big = { row: r, value: n };
    }

    if (bestRun.n >= BADGE_THRESHOLDS.streak) {
      out.push({ kind: "streak", playerId, name, value: bestRun.n, gameNumber: bestRun.at });
    }
    if (bestAttend.n >= BADGE_THRESHOLDS.regular) {
      out.push({ kind: "regular", playerId, name, value: bestAttend.n, gameNumber: bestAttend.at });
    }
    if (low < 0 && total > 0) out.push({ kind: "comeback", playerId, name, value: total - low });
  }

  if (big) {
    out.push({ kind: "bigWin", playerId: big.row.playerId, name: big.row.name, value: big.value, gameNumber: big.row.number });
  }

  const order: Record<BadgeKind, number> = { bigWin: 0, streak: 1, comeback: 2, regular: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || b.value - a.value || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- seasons

export interface Period {
  /** Inclusive, UTC midnight. */
  start: Date;
  /** Exclusive, UTC midnight; null for an open season. */
  end: Date | null;
}

export function inPeriod(at: Date, p: Period): boolean {
  return at >= p.start && (p.end === null || at < p.end);
}

export function rowsInPeriod(rows: readonly ResultRow[], p: Period): ResultRow[] {
  return rows.filter((r) => inPeriod(r.closedAt, p));
}

/**
 * The calendar month containing `day`, in the given calendar ("gregory", "persian",
 * "islamic-umalqura"...), as whole UTC days. Walks day by day, so it works for any calendar
 * Intl knows without month-length tables.
 */
export function monthOf(day: Date, calendar = "gregory"): Period {
  const fmt = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, { timeZone: "UTC", month: "numeric", year: "numeric" });
  const key = (d: Date) => fmt.format(d);
  const DAY = 86_400_000;
  const base = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const month = key(new Date(base));
  let start = base;
  while (key(new Date(start - DAY)) === month) start -= DAY;
  let end = base + DAY;
  while (key(new Date(end)) === month) end += DAY;
  return { start: new Date(start), end: new Date(end) };
}
