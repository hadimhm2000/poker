import { headToHead, homeStats } from "@poker/domain";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { LineChart } from "@/components/charts";
import { Link } from "@/i18n/navigation";
import { formatAmount, formatDate } from "@/lib/format";
import { loadHomeResults, playerSlots } from "@/lib/home";
import { withUser } from "@/lib/session";

export default async function PlayerPage({ params }: { params: Promise<{ homeId: string; playerId: string }> }) {
  const { homeId, playerId } = await params;
  const locale = await getLocale();
  const t = await getTranslations("stats");
  const data = await withUser((tx) => loadHomeResults(tx, homeId));
  if (!data) notFound();
  const { home, rows } = data;
  const mine = rows.filter((r) => r.playerId === playerId);
  if (!mine.length) notFound();
  const s = homeStats(rows);
  const me = s.leaderboard.find((p) => p.playerId === playerId)!;
  const curve = s.cumulative.find((c) => c.playerId === playerId)!;
  const h2h = headToHead(rows, playerId);
  const money = (n: number, signed = false) => formatAmount(n, home, locale, signed);
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  const pct = (n: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(n);
  const cls = (n: number) => (n > 0 ? "win" : n < 0 ? "loss" : "");

  return (
    <>
      <p className="small">
        <Link href={`/homes/${home.id}/stats`}>← {t("stats")}</Link>
      </p>
      <h1>{me.name}</h1>
      <div className="stats" style={{ marginBlockEnd: 16 }}>
        {(
          [
            ["played", num(me.games), ""],
            ["net", money(me.net, true), cls(me.net)],
            ["winRate", pct(me.winRate), ""],
            ["average", money(me.average, true), cls(me.average)],
            ["best", money(me.best, true), cls(me.best)],
            ["worst", money(me.worst, true), cls(me.worst)],
          ] as const
        ).map(([k, v, c]) => (
          <div className="stat" key={k}>
            <div className="label">{t(k)}</div>
            <div className={`value num ${c}`}>{v}</div>
          </div>
        ))}
      </div>

      <section className="card">
        <h2>{t("cumulative")}</h2>
        <LineChart
          title={t("cumulative")}
          series={[
            {
              key: playerId,
              name: me.name,
              slot: playerSlots(rows).get(playerId)!,
              points: curve.points.map((p, i) => ({ x: i, y: p.total, label: `#${num(p.number)}` })),
            },
          ]}
          xLabels={curve.points.map((p) => `#${num(p.number)}`)}
          format={(v) => money(v, true)}
        />
      </section>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <section className="card table-wrap">
          <h2>{t("headToHead")}</h2>
          <table>
            <thead>
              <tr>
                <th>{t("opponent")}</th>
                <th className="end">{t("together")}</th>
                <th className="end">{t("ahead")}</th>
                <th className="end">{t("behind")}</th>
                <th className="end">{t("yourNet")}</th>
                <th className="end">{t("opponentNet")}</th>
              </tr>
            </thead>
            <tbody>
              {h2h.map((h) => (
                <tr key={h.opponentId}>
                  <td>
                    <Link href={`/homes/${home.id}/players/${h.opponentId}`}>{h.name}</Link>
                  </td>
                  <td className="end num">{num(h.games)}</td>
                  <td className="end num">{num(h.ahead)}</td>
                  <td className="end num">{num(h.behind)}</td>
                  <td className={`end num ${cls(h.myNet)}`}>{money(h.myNet, true)}</td>
                  <td className={`end num ${cls(h.theirNet)}`}>{money(h.theirNet, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card table-wrap">
          <h2>{t("gamesOf", { name: me.name })}</h2>
          <table>
            <tbody>
              {[...mine].reverse().map((r) => (
                <tr key={r.gameId}>
                  <td>
                    <Link href={`/games/${r.gameId}`}>#{num(r.number)}</Link>
                  </td>
                  <td className="small">{formatDate(r.closedAt, locale)}</td>
                  <td className="end num">{money(r.totalIn)}</td>
                  <td className={`end num ${cls(r.cashOut - r.totalIn)}`}>{money(r.cashOut - r.totalIn, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
