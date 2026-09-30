import { drawDetails, schema } from "@poker/db";
import { and, eq, inArray } from "@poker/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { revealDrawAction } from "@/app/actions/ideas";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ContributeButton, DrawRecheck } from "@/components/ideas";
import { LiveRefresh } from "@/components/live";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { withUser } from "@/lib/session";

/**
 * A fair draw, for the members of the home: the commitment published before anyone could know
 * the result, each player's own randomness, and after the reveal the seed and every step, so
 * anyone can recompute the seat order (this page also does it in the browser).
 */
export default async function DrawPage({
  params,
  searchParams,
}: {
  params: Promise<{ drawId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { drawId } = await params;
  const { error } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(drawId)) notFound();
  const locale = await getLocale();
  const t = await getTranslations("ideas");

  const data = await withUser(async (tx, user) => {
    const d = await drawDetails(tx, drawId);
    if (!d) return null;
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, d.draw.homeId));
    const [game] = await tx.select().from(schema.games).where(eq(schema.games.id, d.draw.gameId));
    const [mine] = await tx
      .select({ id: schema.players.id })
      .from(schema.players)
      .where(and(eq(schema.players.userId, user.id), inArray(schema.players.id, d.draw.players)));
    return { ...d, home: home!, game: game!, myPlayer: mine?.id ?? null, isHost: home!.ownerId === user.id && !home!.readOnly };
  });
  if (!data) notFound();
  const { draw, contributions, names, check, home, game, myPlayer, isHost } = data;
  const name = (id: string) => names.get(id) ?? "?";
  const contributed = new Set(contributions.map((c) => c.playerId));
  const open = !draw.revealedAt;

  return (
    <>
      <p className="small">
        <Link href={`/games/${game.id}#draw`}>← {home.name}</Link>
      </p>
      <h1>
        🎲 {t("drawTitle")} <span className={`badge ${open ? "live" : "closed"}`}>{open ? t("drawStatusOpen") : t("drawStatusRevealed")}</span>
      </h1>
      {game.status === "live" && <LiveRefresh gameId={game.id} />}
      <ErrorNotice code={error} />
      <p className="muted">{t("drawHow")}</p>

      {check && (
        <section className="card stack">
          <h2>{t("drawResult")}</h2>
          <ol style={{ paddingInlineStart: 24, margin: 0 }}>
            {check.result.order.map((p, i) => (
              <li key={p}>
                <strong>{name(p)}</strong> {i === 0 && <span className="badge">{t("dealer")}</span>}
              </li>
            ))}
          </ol>
          <div className={`alert${check.commitOk ? " ok" : ""}`}>{check.commitOk ? t("commitOk") : t("commitBad")}</div>
          <DrawRecheck
            commit={draw.commit}
            seed={draw.seed!}
            players={draw.players}
            contributions={contributions.map((c) => ({ playerId: c.playerId, value: c.value }))}
            expected={check.result.order}
          />
        </section>
      )}

      {open && myPlayer && !contributed.has(myPlayer) && (
        <section className="card stack">
          <h2>{t("addRandomness")}</h2>
          <p className="small muted">{t("contributeHint")}</p>
          <ContributeButton drawId={draw.id} />
        </section>
      )}

      {open && isHost && (
        <section className="card stack">
          <p className="small muted">{t("revealHint", { count: contributions.length, total: draw.players.length })}</p>
          <form action={revealDrawAction}>
            <input type="hidden" name="drawId" value={draw.id} />
            <button className="btn" type="submit">
              {t("reveal")}
            </button>
          </form>
        </section>
      )}

      <section className="card stack">
        <h2>{t("proof")}</h2>
        <dl className="small">
          <dt>{t("commit")}</dt>
          <dd className="mono break" dir="ltr">
            {draw.commit}
          </dd>
          <dt>{t("committedAt")}</dt>
          <dd>{formatDate(draw.createdAt, locale, true)}</dd>
          <dt>{t("seed")}</dt>
          <dd className="mono break" dir="ltr">
            {draw.seed ?? t("seedHidden")}
          </dd>
          {check && (
            <>
              <dt>{t("key")}</dt>
              <dd className="mono break" dir="ltr">
                {check.result.key}
              </dd>
            </>
          )}
        </dl>
        <h3 style={{ margin: 0 }}>{t("drawPlayers")}</h3>
        <div className="table-wrap">
          <table>
            <tbody>
              {(check?.result.sorted ?? [...draw.players].sort()).map((p, i) => {
                const c = contributions.find((x) => x.playerId === p);
                return (
                  <tr key={p}>
                    <td className="num">{i}</td>
                    <td>{name(p)}</td>
                    <td className="mono small break" dir="ltr">
                      {p}
                    </td>
                    <td className="mono small break" dir="ltr">
                      {c ? c.value : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {check && (
          <>
            <h3 style={{ margin: 0 }}>{t("steps")}</h3>
            <ul className="plain small mono" dir="ltr">
              {check.result.steps.map((s) => (
                <li key={s.i}>{t("stepLine", { i: s.i, j: s.j })}</li>
              ))}
            </ul>
          </>
        )}
        <pre className="break small">{t("algorithm")}</pre>
      </section>
    </>
  );
}
