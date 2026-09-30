import { randomUUID } from "node:crypto";
import { type CloseBlocker, balancesWithOpenDebts, closeBlockers, deriveStatus, liveTotals, netResults, settle } from "@poker/domain";
import { pendingRequests, schema } from "@poker/db";
import { and, eq, gt, isNull, sql } from "@poker/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { addToGameAction, closeGameAction, confirmResultAction, removeFromGameAction } from "@/app/actions/homes";
import { claimPlayerAction, makeJoinLinkAction, requestRebuyAction } from "@/app/actions/live";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ShareCard } from "@/components/ShareCard";
import { AnswerRequest, CopyButton, HostEntryControls, HostQueue, LiveRefresh } from "@/components/live";
import { Link } from "@/i18n/navigation";
import { formatAmount, formatDate } from "@/lib/format";
import { appOrigin, joinToken, qrDataUrl } from "@/lib/live";
import { withUser } from "@/lib/session";

export default async function GamePage({
  params,
  searchParams,
}: {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<{ error?: string; summary?: string }>;
}) {
  const { gameId } = await params;
  const { error, summary } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(gameId)) notFound();
  const locale = await getLocale();
  const t = await getTranslations("game");
  const tc = await getTranslations("card");

  const data = await withUser(async (tx, user) => {
    const [game] = await tx.select().from(schema.games).where(eq(schema.games.id, gameId));
    if (!game) return null;
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, game.homeId));
    const players = await tx.select().from(schema.players).where(eq(schema.players.homeId, game.homeId));
    const entries = await tx.select().from(schema.gameEntries).where(eq(schema.gameEntries.gameId, gameId));
    const settlements = await tx.select().from(schema.settlements).where(eq(schema.settlements.gameId, gameId));
    // Open debts between tonight's players, for the settlement preview.
    const open = await tx
      .select({ from: schema.openDebts.fromPlayer, to: schema.openDebts.toPlayer, amount: schema.openDebts.remaining })
      .from(schema.openDebts)
      .where(eq(schema.openDebts.homeId, game.homeId));
    const requests = game.status === "live" ? await pendingRequests(tx, game.id) : [];
    const isHost = home!.ownerId === user.id;
    const [invite] =
      isHost && game.status === "live"
        ? await tx
            .select({ id: schema.invites.id })
            .from(schema.invites)
            .where(
              and(
                eq(schema.invites.gameId, game.id),
                isNull(schema.invites.revokedAt),
                gt(schema.invites.expiresAt, sql`now()`),
                sql`${schema.invites.uses} < ${schema.invites.maxUses}`,
              ),
            )
            .limit(1)
        : [];
    return { game, home: home!, players, entries, settlements, open, requests, invite, userId: user.id };
  });
  if (!data) notFound();
  const { game, home, players, entries, settlements, open, requests, invite, userId } = data;
  const name = new Map(players.map((p) => [p.id, p.displayName]));
  const byId = new Map(players.map((p) => [p.id, p]));
  const moneyHome = { currency: home.currency, unitSuffix: home.unitSuffix, unitDivisor: home.unitDivisor };
  const money = (n: number, signed = false) => formatAmount(n, moneyHome, locale, signed);
  const canWrite = home.ownerId === userId && !home.readOnly && game.status !== "closed";
  const rules = { requireConfirmation: home.requireConfirmation };
  const domainEntries = entries.map((e) => ({
    playerId: e.playerId,
    totalIn: e.totalIn,
    cashOut: e.cashOut,
    confirmed: !!e.confirmedAt,
    hasAccount: !!byId.get(e.playerId)?.userId,
  }));
  const status = deriveStatus(game.status, domainEntries, rules);
  const totals = liveTotals(domainEntries);
  const blockers = game.status === "closed" ? [] : closeBlockers(domainEntries, rules);
  const inGame = new Set(entries.map((e) => e.playerId));
  const myEntry = entries.find((e) => byId.get(e.playerId)?.userId === userId);
  const isLive = game.status === "live";
  const hasPlayerInHome = players.some((p) => p.userId === userId);
  const claimable = isLive && !canWrite && !hasPlayerInHome ? entries.filter((e) => !byId.get(e.playerId)?.userId) : [];
  const myRequest = myEntry ? requests.find((r) => r.playerId === myEntry.playerId) : undefined;
  const joinUrl = canWrite && invite ? `${await appOrigin()}/${locale}/join/${joinToken(invite.id)}` : null;
  const joinQr = joinUrl ? await qrDataUrl(joinUrl) : null;

  const describe = (b: CloseBlocker) => {
    const names = "playerIds" in b ? new Intl.ListFormat(locale).format(b.playerIds.map((id) => name.get(id) ?? "?")) : "";
    switch (b.code) {
      case "MIN_PLAYERS":
        return t("blocked_MIN_PLAYERS", { min: b.min });
      case "UNBALANCED":
        return t("blocked_UNBALANCED", { difference: money(b.difference, true) });
      default:
        return t(`blocked_${b.code}`, { names });
    }
  };

  const transfers =
    game.status === "closed"
      ? settlements.map((s) => ({ from: s.fromPlayer, to: s.toPlayer, amount: s.amount }))
      : blockers.length === 0
        ? settle(balancesWithOpenDebts(netResults(domainEntries), open.filter((d) => inGame.has(d.from) && inGame.has(d.to))))
        : [];

  const requestList = requests.length > 0 && (
    <section className="card">
      <h2>{t("requests")}</h2>
      <ul className="plain stack">
        {requests.map((r) => (
          <li key={r.id} className="row" style={{ justifyContent: "space-between" }}>
            <span>{t("requestLine", { name: name.get(r.playerId) ?? "?", amount: money(r.amount) })}</span>
            {canWrite ? <AnswerRequest requestId={r.id} /> : <span className="badge">{t("waitingHost")}</span>}
          </li>
        ))}
      </ul>
    </section>
  );

  const table = (
    <section className="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t("player")}</th>
            <th className="end">{t("in")}</th>
            <th className="end">{t("cashOut")}</th>
            <th className="end">{t("net")}</th>
            {canWrite && <th />}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const net = e.cashOut === null ? null : e.cashOut - e.totalIn;
            const p = byId.get(e.playerId);
            return (
              <tr key={e.playerId} className={p?.userId === userId ? "me" : undefined}>
                <td>
                  {name.get(e.playerId)} {e.confirmedAt && <span className="badge" title={t("confirmed")}>✓</span>}
                </td>
                <td className="end num">{money(e.totalIn)}</td>
                <td className="end">
                  {canWrite ? (
                    <HostEntryControls playerId={e.playerId} defaultBuyIn={game.defaultBuyIn} cashOut={e.cashOut} home={moneyHome} />
                  ) : (
                    <span className="num">{e.cashOut === null ? "—" : money(e.cashOut)}</span>
                  )}
                </td>
                <td className={`end num ${net === null ? "" : net > 0 ? "win" : net < 0 ? "loss" : ""}`}>
                  {net === null ? "—" : money(net, true)}
                </td>
                {canWrite && (
                  <td className="end">
                    {e.totalIn === 0 && (
                      <form action={removeFromGameAction}>
                        <input type="hidden" name="gameId" value={game.id} />
                        <input type="hidden" name="playerId" value={e.playerId} />
                        <button className="linklike" type="submit" aria-label="remove">
                          ✕
                        </button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {canWrite && players.some((p) => !inGame.has(p.id) && !p.mergedInto) && (
        <form action={addToGameAction} className="row" style={{ marginBlockStart: 12 }}>
          <input type="hidden" name="gameId" value={game.id} />
          <select name="playerId" style={{ width: "auto" }} aria-label={t("player")} required>
            {players
              .filter((p) => !inGame.has(p.id) && !p.mergedInto)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
          </select>
          <button className="btn secondary" type="submit">
            {t("addToGame")} ({money(game.defaultBuyIn)})
          </button>
        </form>
      )}
    </section>
  );

  return (
    <>
      <p className="small">
        <Link href={`/homes/${home.id}`}>← {home.name}</Link>
      </p>
      <h1>
        {game.number ? t("title", { number: new Intl.NumberFormat(locale).format(game.number) }) : t("untitled")}{" "}
        <span className={`badge ${game.status === "closed" ? "closed" : "live"}`}>{t(`status_${status}`)}</span>
      </h1>
      {isLive && <LiveRefresh gameId={game.id} />}
      <ErrorNotice code={error} />
      {game.status === "closed" && (
        <div className="alert">
          {t("frozen")} {game.closedAt && t("closedAt", { date: formatDate(game.closedAt, locale, true) })}
        </div>
      )}

      <div className="stats" style={{ marginBlockEnd: 16 }}>
        <div className="stat">
          <div className="label">{t("pot")}</div>
          <div className="value num">{money(totals.pot)}</div>
        </div>
        <div className="stat">
          <div className="label">{t("cashedOut")}</div>
          <div className="value num">{money(totals.cashedOut)}</div>
        </div>
        <div className="stat">
          <div className="label">{t("difference")}</div>
          <div className={`value num ${totals.difference === 0 ? "" : "loss"}`}>{money(totals.difference, true)}</div>
        </div>
      </div>

      {canWrite ? (
        <HostQueue gameId={game.id}>
          {requestList}
          {table}
        </HostQueue>
      ) : (
        <>
          {requestList}
          {table}
        </>
      )}

      {claimable.length > 0 && (
        <section className="card stack">
          <h2>{t("whoAreYou")}</h2>
          <p className="small muted">{t("whoAreYouHint")}</p>
          <div className="row">
            {claimable.map((e) => (
              <form key={e.playerId} action={claimPlayerAction}>
                <input type="hidden" name="gameId" value={game.id} />
                <input type="hidden" name="playerId" value={e.playerId} />
                <button className="btn secondary" type="submit">
                  {t("thisIsMe", { name: name.get(e.playerId) ?? "?" })}
                </button>
              </form>
            ))}
          </div>
        </section>
      )}

      {isLive && myEntry && !canWrite && (
        <section className="card row">
          {myRequest ? (
            <span className="badge">{t("requestSent", { amount: money(myRequest.amount) })}</span>
          ) : (
            <form action={requestRebuyAction}>
              <input type="hidden" name="gameId" value={game.id} />
              <button className="btn" type="submit" disabled={game.defaultBuyIn <= 0}>
                {t("askRebuy", { amount: money(game.defaultBuyIn) })}
              </button>
            </form>
          )}
        </section>
      )}

      {game.status !== "closed" && myEntry && !myEntry.confirmedAt && myEntry.cashOut !== null && (
        <form action={confirmResultAction} style={{ marginBlockEnd: 16 }}>
          <input type="hidden" name="gameId" value={game.id} />
          <button className="btn secondary" type="submit">
            {t("confirmMine")}
          </button>
        </form>
      )}

      {canWrite && isLive && (
        <section className="card" id="join">
          <h2>{t("joinQr")}</h2>
          {joinUrl && joinQr ? (
            <div className="stack" style={{ alignItems: "center", marginBlockStart: 12 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={joinQr} width={260} height={260} alt={t("joinQrAlt")} />
              <p className="small muted">{t("joinQrHint")}</p>
              <p className="mono small" dir="ltr" style={{ overflowWrap: "anywhere" }}>
                {joinUrl}
              </p>
              <CopyButton text={joinUrl} label={t("copyLink")} done={t("copied")} />
            </div>
          ) : (
            <form action={makeJoinLinkAction} style={{ marginBlockStart: 12 }}>
              <input type="hidden" name="gameId" value={game.id} />
              <button className="btn secondary" type="submit">
                {t("makeJoinQr")}
              </button>
            </form>
          )}
        </section>
      )}

      {(game.status === "closed" || summary || blockers.length === 0) && (
        <section className="card">
          <h2>{t("settlement")}</h2>
          {transfers.length === 0 ? (
            <p className="muted">{t("nothingToSettle")}</p>
          ) : (
            <table>
              <tbody>
                {transfers.map((tr, i) => (
                  <tr key={i}>
                    <td>{t("pays", { from: name.get(tr.from) ?? "?", to: name.get(tr.to) ?? "?" })}</td>
                    <td className="end num">{money(tr.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {canWrite && (
        <section className="card stack">
          {blockers.length > 0 ? (
            <ul className="alert" style={{ paddingInlineStart: 28 }}>
              {blockers.map((b) => (
                <li key={b.code}>{describe(b)}</li>
              ))}
            </ul>
          ) : summary ? (
            <>
              <h2>{t("summary")}</h2>
              <div className="alert">{t("warning")}</div>
              <form action={closeGameAction} className="row">
                <input type="hidden" name="gameId" value={game.id} />
                <input type="hidden" name="closeKey" value={randomUUID()} />
                <input type="hidden" name="version" value={game.version} />
                <button className="btn danger" type="submit">
                  {t("confirmClose")}
                </button>
                <Link className="btn secondary" href={`/games/${game.id}`}>
                  {t("cancel")}
                </Link>
              </form>
            </>
          ) : (
            <Link className="btn" href={`/games/${game.id}?summary=1`}>
              {t("close")}
            </Link>
          )}
        </section>
      )}

      {game.status === "closed" && game.hash && (
        <section className="card stack" id="card">
          <h2>{tc("heading")}</h2>
          <p className="small muted">{tc("intro")}</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a private PNG from our own route */}
          <img className="result-card-img" src={`/api/games/${game.id}/card`} alt={tc("heading")} width={1080} height={1350} />
          <div className="row">
            <ShareCard src={`/api/games/${game.id}/card?f=story`} label={tc("share")} filename={`poker-home-${game.number}.png`} />
            <a className="btn small secondary" href={`/api/games/${game.id}/card?download`}>
              {tc("post")}
            </a>
            <a className="btn small secondary" href={`/api/games/${game.id}/card?f=story&download`}>
              {tc("story")}
            </a>
            <Link className="btn small secondary" href={`/verify/${game.hash}`}>
              {tc("verifyLink")}
            </Link>
          </div>
          <p className="small muted">
            {t("fingerprint")}: <span className="mono">{game.hash}</span>
          </p>
        </section>
      )}
    </>
  );
}
