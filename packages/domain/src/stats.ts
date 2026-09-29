import { type Money, sum } from "./money";

/** One row of the history sheet: a player's result in one closed game. */
export interface ResultRow {
  gameId: string;
  number: number;
  closedAt: Date;
  playerId: string;
  name: string;
  totalIn: Money;
  cashOut: Money;
}

export interface PlayerStats {
  playerId: string;
  name: string;
  games: number;
  net: Money;
  totalIn: Money;
  wins: number;
  losses: number;
  evens: number;
  /** wins / games, 0..1 */
  winRate: number;
  /** net / games, rounded to an integer money value */
  average: Money;
  best: Money;
  worst: Money;
  /** 1, 2, 3 for the top three by net; null otherwise */
  medal: 1 | 2 | 3 | null;
}

export interface GameSummary {
  gameId: string;
  number: number;
  closedAt: Date;
  pot: Money;
  players: number;
  topWinner: { playerId: string; name: string; net: Money } | null;
  topLoser: { playerId: string; name: string; net: Money } | null;
}

export interface RecordEntry {
  playerId: string;
  name: string;
  value: number;
  gameNumber?: number;
}

export interface HomeStats {
  totals: { games: number; players: number; moneyIn: Money; biggestPot: Money; averagePot: Money };
  leaderboard: PlayerStats[];
  games: GameSummary[];
  lastGames: GameSummary[];
  records: {
    biggestWin: RecordEntry | null;
    biggestLoss: RecordEntry | null;
    longestWinStreak: RecordEntry | null;
    longestLossStreak: RecordEntry | null;
    mostGames: RecordEntry | null;
    bestAverage: RecordEntry | null;
  };
  /** Cumulative net after each game, per player: the "profit over time" chart. */
  cumulative: { playerId: string; name: string; points: { number: number; closedAt: Date; total: Money }[] }[];
}

const net = (r: ResultRow) => r.cashOut - r.totalIn;
const byGameOrder = (a: { number: number; closedAt: Date }, b: { number: number; closedAt: Date }) =>
  a.closedAt.getTime() - b.closedAt.getTime() || a.number - b.number;

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

function streaks(results: readonly Money[]): { win: number; loss: number } {
  let win = 0;
  let loss = 0;
  let w = 0;
  let l = 0;
  for (const n of results) {
    w = n > 0 ? w + 1 : 0;
    l = n < 0 ? l + 1 : 0;
    win = Math.max(win, w);
    loss = Math.max(loss, l);
  }
  return { win, loss };
}

function topBy<T>(items: readonly T[], score: (t: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bestScore) {
      best = it;
      bestScore = s;
    }
  }
  return best;
}

export function summarizeGames(rows: readonly ResultRow[]): GameSummary[] {
  return [...groupBy(rows, (r) => r.gameId).values()]
    .map((g) => {
      const first = g[0]!;
      const sorted = [...g].sort((a, b) => net(b) - net(a) || a.name.localeCompare(b.name));
      const top = sorted[0]!;
      const bottom = sorted[sorted.length - 1]!;
      return {
        gameId: first.gameId,
        number: first.number,
        closedAt: first.closedAt,
        pot: sum(g.map((r) => r.totalIn)),
        players: g.length,
        topWinner: net(top) > 0 ? { playerId: top.playerId, name: top.name, net: net(top) } : null,
        topLoser: net(bottom) < 0 ? { playerId: bottom.playerId, name: bottom.name, net: net(bottom) } : null,
      };
    })
    .sort(byGameOrder);
}

/** Everything on the statistics page (sheet 3), from closed-game rows only. */
export function homeStats(rows: readonly ResultRow[], opts: { lastGames?: number } = {}): HomeStats {
  const games = summarizeGames(rows);
  const order = new Map(games.map((g, i) => [g.gameId, i]));
  const byPlayer = groupBy(rows, (r) => r.playerId);

  const leaderboard: PlayerStats[] = [...byPlayer.entries()].map(([playerId, list]) => {
    const nets = list.map(net);
    const wins = nets.filter((n) => n > 0).length;
    const losses = nets.filter((n) => n < 0).length;
    const total = sum(nets);
    return {
      playerId,
      name: list[list.length - 1]!.name,
      games: list.length,
      net: total,
      totalIn: sum(list.map((r) => r.totalIn)),
      wins,
      losses,
      evens: list.length - wins - losses,
      winRate: wins / list.length,
      average: Math.round(total / list.length),
      best: Math.max(...nets),
      worst: Math.min(...nets),
      medal: null,
    };
  });
  leaderboard.sort((a, b) => b.net - a.net || b.winRate - a.winRate || a.name.localeCompare(b.name));
  leaderboard.slice(0, 3).forEach((p, i) => {
    if (p.net > 0 || i === 0) p.medal = (i + 1) as 1 | 2 | 3;
  });

  const cumulative = [...byPlayer.entries()].map(([playerId, list]) => {
    const ordered = [...list].sort((a, b) => order.get(a.gameId)! - order.get(b.gameId)!);
    let total = 0;
    return {
      playerId,
      name: ordered[ordered.length - 1]!.name,
      points: ordered.map((r) => {
        total += net(r);
        return { number: r.number, closedAt: r.closedAt, total };
      }),
    };
  });

  const perPlayerStreaks = cumulative.map((c) => {
    const nets = c.points.map((p, i) => p.total - (i ? c.points[i - 1]!.total : 0));
    return { playerId: c.playerId, name: c.name, ...streaks(nets) };
  });

  const bigWin = topBy(rows, net);
  const bigLoss = topBy(rows, (r) => -net(r));
  const winStreak = topBy(perPlayerStreaks, (s) => s.win);
  const lossStreak = topBy(perPlayerStreaks, (s) => s.loss);
  const most = topBy(leaderboard, (p) => p.games);
  const eligibleForAverage = leaderboard.filter((p) => p.games >= Math.min(3, Math.max(1, games.length)));
  const bestAvg = topBy(eligibleForAverage, (p) => p.average);

  const pots = games.map((g) => g.pot);
  return {
    totals: {
      games: games.length,
      players: byPlayer.size,
      moneyIn: sum(pots),
      biggestPot: pots.length ? Math.max(...pots) : 0,
      averagePot: pots.length ? Math.round(sum(pots) / pots.length) : 0,
    },
    leaderboard,
    games,
    lastGames: games.slice(-(opts.lastGames ?? 10)).reverse(),
    records: {
      biggestWin: bigWin && net(bigWin) > 0 ? { playerId: bigWin.playerId, name: bigWin.name, value: net(bigWin), gameNumber: bigWin.number } : null,
      biggestLoss: bigLoss && net(bigLoss) < 0 ? { playerId: bigLoss.playerId, name: bigLoss.name, value: net(bigLoss), gameNumber: bigLoss.number } : null,
      longestWinStreak: winStreak && winStreak.win > 0 ? { playerId: winStreak.playerId, name: winStreak.name, value: winStreak.win } : null,
      longestLossStreak: lossStreak && lossStreak.loss > 0 ? { playerId: lossStreak.playerId, name: lossStreak.name, value: lossStreak.loss } : null,
      mostGames: most ? { playerId: most.playerId, name: most.name, value: most.games } : null,
      bestAverage: bestAvg ? { playerId: bestAvg.playerId, name: bestAvg.name, value: bestAvg.average } : null,
    },
    cumulative,
  };
}

export interface HeadToHead {
  opponentId: string;
  name: string;
  /** games both played */
  games: number;
  /** games where I finished ahead of them */
  ahead: number;
  behind: number;
  /** my net and theirs over the shared games */
  myNet: Money;
  theirNet: Money;
}

/** Head-to-head of one player against everyone they shared a table with. */
export function headToHead(rows: readonly ResultRow[], playerId: string): HeadToHead[] {
  const byGame = groupBy(rows, (r) => r.gameId);
  const out = new Map<string, HeadToHead>();
  for (const g of byGame.values()) {
    const me = g.find((r) => r.playerId === playerId);
    if (!me) continue;
    for (const other of g) {
      if (other.playerId === playerId) continue;
      const h =
        out.get(other.playerId) ??
        { opponentId: other.playerId, name: other.name, games: 0, ahead: 0, behind: 0, myNet: 0, theirNet: 0 };
      h.games++;
      if (net(me) > net(other)) h.ahead++;
      else if (net(me) < net(other)) h.behind++;
      h.myNet += net(me);
      h.theirNet += net(other);
      out.set(other.playerId, h);
    }
  }
  return [...out.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
}
