import { describe, expect, it } from "vitest";
import { type ResultRow, headToHead, homeStats } from "../src/stats";

function game(number: number, day: number, results: Record<string, [number, number]>): ResultRow[] {
  const gameId = `g${number}`;
  return Object.entries(results).map(([name, [totalIn, cashOut]]) => ({
    gameId,
    number,
    closedAt: new Date(Date.UTC(2026, 0, day)),
    playerId: `p-${name}`,
    name,
    totalIn,
    cashOut,
  }));
}

const rows = [
  ...game(1, 1, { ali: [500, 900], sara: [500, 100], reza: [500, 500] }),
  ...game(2, 8, { ali: [1000, 1500], sara: [500, 0] }),
  ...game(3, 15, { ali: [500, 0], sara: [500, 1200], reza: [500, 300] }),
  ...game(4, 22, { ali: [500, 700], sara: [500, 300] }),
];

describe("homeStats", () => {
  const s = homeStats(rows);

  it("totals", () => {
    expect(s.totals).toEqual({ games: 4, players: 3, moneyIn: 1500 + 1500 + 1500 + 1000, biggestPot: 1500, averagePot: 1375 });
  });

  it("leaderboard is sorted by net with medals for winners", () => {
    expect(s.leaderboard.map((p) => [p.name, p.net, p.medal])).toEqual([
      ["ali", 600, 1],
      ["reza", -200, null],
      ["sara", -400, null],
    ]);
    const ali = s.leaderboard[0]!;
    expect(ali).toMatchObject({ games: 4, wins: 3, losses: 1, evens: 0, winRate: 0.75, average: 150, best: 500, worst: -500 });
  });

  it("every game's nets sum to zero and the leaderboard sums to zero", () => {
    expect(s.leaderboard.reduce((a, p) => a + p.net, 0)).toBe(0);
  });

  it("last games are newest first with top winner and loser", () => {
    expect(s.lastGames.map((g) => g.number)).toEqual([4, 3, 2, 1]);
    expect(s.lastGames[1]).toMatchObject({ pot: 1500, players: 3, topWinner: { name: "sara", net: 700 }, topLoser: { name: "ali", net: -500 } });
  });

  it("records", () => {
    expect(s.records.biggestWin).toMatchObject({ name: "sara", value: 700, gameNumber: 3 });
    expect(s.records.biggestLoss).toMatchObject({ name: "sara", value: -500, gameNumber: 2 });
    expect(s.records.longestWinStreak).toMatchObject({ name: "ali", value: 2 });
    expect(s.records.longestLossStreak).toMatchObject({ name: "sara", value: 2 });
    expect(s.records.mostGames).toMatchObject({ value: 4 });
  });

  it("cumulative profit ends at each player's net", () => {
    for (const c of s.cumulative) {
      const p = s.leaderboard.find((x) => x.playerId === c.playerId)!;
      expect(c.points.at(-1)!.total).toBe(p.net);
      expect(c.points.length).toBe(p.games);
    }
    expect(s.cumulative.find((c) => c.name === "ali")!.points.map((p) => p.total)).toEqual([400, 900, 400, 600]);
  });

  it("empty history", () => {
    const e = homeStats([]);
    expect(e.totals.games).toBe(0);
    expect(e.leaderboard).toEqual([]);
    expect(e.records.biggestWin).toBeNull();
  });
});

describe("headToHead", () => {
  it("counts shared games and who finished ahead", () => {
    const h = headToHead(rows, "p-ali");
    expect(h).toEqual([
      { opponentId: "p-sara", name: "sara", games: 4, ahead: 3, behind: 1, myNet: 600, theirNet: -400 },
      { opponentId: "p-reza", name: "reza", games: 2, ahead: 1, behind: 1, myNet: -100, theirNet: -200 },
    ]);
  });
});
