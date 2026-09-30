import { homePlan, listSeasons, seasonPeriod } from "@poker/db";
import { badges, homeStats, rowsInPeriod } from "@poker/domain";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { createSeasonAction, deleteSeasonAction } from "@/app/actions/seasons";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PrintButton } from "@/components/PrintButton";
import { DivergingBars, LineChart } from "@/components/charts";
import { Link } from "@/i18n/navigation";
import { formatAmount, formatDate } from "@/lib/format";
import { loadHomeResults, playerSlots } from "@/lib/home";
import { withUser } from "@/lib/session";

const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" } as const;
const MAX_LINES = 8;
const BADGE_ICON = { streak: "🔥", bigWin: "💰", regular: "📅", comeback: "🔄" } as const;

export default async function StatsPage({
  params,
  searchParams,
}: {
  params: Promise<{ homeId: string }>;
  searchParams: Promise<{ season?: string; error?: string }>;
}) {
  const { homeId } = await params;
  const { season: seasonId, error } = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations("stats");
  const tse = await getTranslations("seasons");
  const tb = await getTranslations("badges");
  const data = await withUser(async (tx, user) => {
    const loaded = await loadHomeResults(tx, homeId);
    return (
      loaded && {
        ...loaded,
        plan: await homePlan(tx, homeId),
        seasons: await listSeasons(tx, homeId),
        canWrite: loaded.home.ownerId === user.id && !loaded.home.readOnly,
      }
    );
  });
  if (!data) notFound();
  const { home, seasons } = data;
  const season = seasons.find((x) => x.id === seasonId) ?? null;
  const rows = season ? rowsInPeriod(data.rows, seasonPeriod(season)) : data.rows;
  const s = homeStats(rows);
  const earned = badges(rows);
  const day = (d: string) => formatDate(new Date(`${d}T12:00:00Z`), locale);
  const money = (n: number, signed = false) => formatAmount(n, home, locale, signed);
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  const pct = (n: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(n);
  const slots = playerSlots(rows);

  // Lines for the most regular players (fixed colour per player); everyone is in the table.
  const regulars = [...s.leaderboard].sort((a, b) => b.games - a.games).slice(0, MAX_LINES).map((p) => p.playerId);
  const gameIndex = new Map(s.games.map((g, i) => [g.number, i]));
  const series = s.cumulative
    .filter((c) => regulars.includes(c.playerId))
    .map((c) => ({
      key: c.playerId,
      name: c.name,
      slot: slots.get(c.playerId)!,
      points: c.points.map((p) => ({ x: gameIndex.get(p.number)!, y: p.total, label: `#${num(p.number)}` })),
    }));
  const r = s.records;

  return (
    <>
      <p className="small no-print">
        <Link href={`/homes/${home.id}`}>← {home.name}</Link>
      </p>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>
          {t("title")} · {home.name}
          {season && ` · ${season.name}`}
        </h1>
        <div className="row no-print" style={{ alignItems: "center" }}>
          {data.plan === "pro" ? (
            <>
              <a className="btn secondary small" href={`/api/homes/${home.id}/export?format=xlsx`}>
                {t("exportXlsx")}
              </a>
              <a className="btn secondary small" href={`/api/homes/${home.id}/export?format=csv`}>
                {t("exportCsv")}
              </a>
            </>
          ) : (
            <span className="small muted">
              {t("exportXlsx")} · {t("exportCsv")}: <Link href="/pricing">{t("proOnly")}</Link>
            </span>
          )}
          <PrintButton label={t("print")} />
        </div>
      </div>

      <ErrorNotice code={error} />
      <section className="card stack no-print" style={{ marginBlockStart: 16 }}>
        <h2>{tse("title")}</h2>
        <nav className="seasons" aria-label={tse("title")}>
          <Link href={`/homes/${home.id}/stats`} className={season ? "" : "current"}>
            {tse("allTime")}
          </Link>
          {seasons.map((x) => (
            <Link key={x.id} href={`/homes/${home.id}/stats?season=${x.id}`} className={x.id === season?.id ? "current" : ""}>
              {x.name}
              {!x.endsOn && <span className="badge live">{tse("running")}</span>}
            </Link>
          ))}
        </nav>
        {season && (
          <p className="small muted">
            {season.endsOn
              ? tse("range", { start: day(season.startsOn), end: day(season.endsOn) })
              : tse("rangeOpen", { start: day(season.startsOn) })}
          </p>
        )}
        <p className="small muted">{tse("intro")}</p>
        {data.canWrite && (
          <details>
            <summary>{tse("create")}</summary>
            <form action={createSeasonAction} className="row" style={{ marginBlockStart: 8 }}>
              <input type="hidden" name="homeId" value={home.id} />
              <label>
                {tse("name")}
                <input name="name" required maxLength={60} />
              </label>
              <label>
                {tse("startsOn")}
                <input name="startsOn" type="date" required />
              </label>
              <label>
                {tse("endsOn")}
                <input name="endsOn" type="date" />
              </label>
              <button className="btn secondary" type="submit">
                {tse("create")}
              </button>
            </form>
            <form action={createSeasonAction} style={{ marginBlockStart: 8 }}>
              <input type="hidden" name="homeId" value={home.id} />
              <input type="hidden" name="preset" value="month" />
              <button className="btn small secondary" type="submit">
                {tse("thisMonth")}
              </button>
            </form>
          </details>
        )}
        {data.canWrite && season && (
          <form action={deleteSeasonAction}>
            <input type="hidden" name="homeId" value={home.id} />
            <input type="hidden" name="seasonId" value={season.id} />
            <button className="btn small danger" type="submit">
              {tse("delete")}: {season.name}
            </button>
          </form>
        )}
      </section>

      {s.totals.games === 0 ? (
        <p className="muted">{season ? tse("empty") : t("empty")}</p>
      ) : (
        <>
          <div className="stats" style={{ marginBlock: 16 }}>
            {(
              [
                ["games", num(s.totals.games)],
                ["players", num(s.totals.players)],
                ["moneyIn", money(s.totals.moneyIn)],
                ["biggestPot", money(s.totals.biggestPot)],
                ["averagePot", money(s.totals.averagePot)],
              ] as const
            ).map(([k, v]) => (
              <div className="stat" key={k}>
                <div className="label">{t(k)}</div>
                <div className="value num">{v}</div>
              </div>
            ))}
          </div>

          <section className="card table-wrap">
            <h2>{season ? t("seasonLeaderboard", { season: season.name }) : t("leaderboard")}</h2>
            <table>
              <thead>
                <tr>
                  <th />
                  <th>{t("player")}</th>
                  <th className="end">{t("played")}</th>
                  <th className="end">{t("wins")}</th>
                  <th className="end">{t("winRate")}</th>
                  <th className="end">{t("net")}</th>
                  <th className="end">{t("average")}</th>
                  <th className="end">{t("best")}</th>
                  <th className="end">{t("worst")}</th>
                </tr>
              </thead>
              <tbody>
                {s.leaderboard.map((p) => (
                  <tr key={p.playerId}>
                    <td className="medal">{p.medal ? MEDAL[p.medal] : ""}</td>
                    <td>
                      <Link href={`/homes/${home.id}/players/${p.playerId}`}>{p.name}</Link>
                    </td>
                    <td className="end num">{num(p.games)}</td>
                    <td className="end num">{num(p.wins)}</td>
                    <td className="end num">{pct(p.winRate)}</td>
                    <td className={`end num ${p.net > 0 ? "win" : p.net < 0 ? "loss" : ""}`}>
                      <strong>{money(p.net, true)}</strong>
                    </td>
                    <td className="end num">{money(p.average, true)}</td>
                    <td className="end num">{money(p.best, true)}</td>
                    <td className="end num">{money(p.worst, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card">
            <h2>{tb("title")}</h2>
            {earned.length === 0 ? (
              <p className="muted small">{tb("none")}</p>
            ) : (
              <div className="badges">
                {earned.map((b) => (
                  <div className="badge-card" key={`${b.kind}-${b.playerId}`}>
                    <span className="icon" aria-hidden="true">
                      {BADGE_ICON[b.kind]}
                    </span>
                    <strong>{tb(b.kind)}</strong>
                    <span>
                      <Link href={`/homes/${home.id}/players/${b.playerId}`}>{b.name}</Link>
                    </span>
                    <span className="small muted">
                      {b.kind === "bigWin"
                        ? tb("bigWinBody", { amount: money(b.value, true), number: num(b.gameNumber!) })
                        : b.kind === "comeback"
                          ? tb("comebackBody", { amount: money(b.value) })
                          : tb(`${b.kind}Body`, { count: num(b.value) })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div>
            <section className="card">
              <h2>{t("cumulative")}</h2>
              <p className="small muted">{t("cumulativeNote", { count: num(series.length) })}</p>
              <LineChart
                title={t("cumulative")}
                series={series}
                xLabels={s.games.map((g) => `#${num(g.number)}`)}
                format={(v) => money(v, true)}
              />
            </section>
            <section className="card">
              <h2>{t("netChart")}</h2>
              <DivergingBars
                title={t("netChart")}
                rows={s.leaderboard.map((p) => ({ key: p.playerId, name: p.name, value: p.net }))}
                format={(v) => money(v, true)}
              />
            </section>
          </div>

          <div className="print-break" />
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
            <section className="card table-wrap">
              <h2>{t("lastGames", { count: num(s.lastGames.length) })}</h2>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t("date")}</th>
                    <th className="end">{t("pot")}</th>
                    <th>{t("topWinner")}</th>
                    <th>{t("topLoser")}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.lastGames.map((g) => (
                    <tr key={g.gameId}>
                      <td>
                        <Link href={`/games/${g.gameId}`}>{num(g.number)}</Link>
                      </td>
                      <td className="small">{formatDate(g.closedAt, locale)}</td>
                      <td className="end num">{money(g.pot)}</td>
                      <td className="small">
                        {g.topWinner && (
                          <>
                            {g.topWinner.name} <span className="win num">{money(g.topWinner.net, true)}</span>
                          </>
                        )}
                      </td>
                      <td className="small">
                        {g.topLoser && (
                          <>
                            {g.topLoser.name} <span className="loss num">{money(g.topLoser.net, true)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card">
              <h2>{t("records")}</h2>
              <table>
                <tbody>
                  {r.biggestWin && (
                    <tr>
                      <td>{t("biggestWin")}</td>
                      <td>{r.biggestWin.name}</td>
                      <td className="end num win">{money(r.biggestWin.value, true)}</td>
                      <td className="small muted">{t("inGame", { number: num(r.biggestWin.gameNumber!) })}</td>
                    </tr>
                  )}
                  {r.biggestLoss && (
                    <tr>
                      <td>{t("biggestLoss")}</td>
                      <td>{r.biggestLoss.name}</td>
                      <td className="end num loss">{money(r.biggestLoss.value, true)}</td>
                      <td className="small muted">{t("inGame", { number: num(r.biggestLoss.gameNumber!) })}</td>
                    </tr>
                  )}
                  {r.longestWinStreak && (
                    <tr>
                      <td>{t("longestWinStreak")}</td>
                      <td>{r.longestWinStreak.name}</td>
                      <td className="end" colSpan={2}>
                        {t("streakValue", { count: num(r.longestWinStreak.value) })}
                      </td>
                    </tr>
                  )}
                  {r.longestLossStreak && (
                    <tr>
                      <td>{t("longestLossStreak")}</td>
                      <td>{r.longestLossStreak.name}</td>
                      <td className="end" colSpan={2}>
                        {t("streakValue", { count: num(r.longestLossStreak.value) })}
                      </td>
                    </tr>
                  )}
                  {r.mostGames && (
                    <tr>
                      <td>{t("mostGames")}</td>
                      <td>{r.mostGames.name}</td>
                      <td className="end num" colSpan={2}>
                        {num(r.mostGames.value)}
                      </td>
                    </tr>
                  )}
                  {r.bestAverage && (
                    <tr>
                      <td>{t("bestAverage")}</td>
                      <td>{r.bestAverage.name}</td>
                      <td className="end num" colSpan={2}>
                        {money(r.bestAverage.value, true)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </>
  );
}
