import { randomUUID } from "node:crypto";
import { type CloseBlocker, balancesWithOpenDebts, closeBlockers, deriveStatus, liveTotals, netResults, settle } from "@poker/domain";
import { schema } from "@poker/db";
import { and, eq, notExists, sql } from "@poker/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  addToGameAction,
  cashOutAction,
  closeGameAction,
  confirmResultAction,
  rebuyAction,
  removeFromGameAction,
} from "@/app/actions/homes";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Link } from "@/i18n/navigation";
import { formatAmount, formatDate, toInputValue } from "@/lib/format";
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

  const data = await withUser(async (tx, user) => {
    const [game] = await tx.select().from(schema.games).where(eq(schema.games.id, gameId));
    if (!game) return null;
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, game.homeId));
    const players = await tx.select().from(schema.players).where(eq(schema.players.homeId, game.homeId));
    const entries = await tx.select().from(schema.gameEntries).where(eq(schema.gameEntries.gameId, gameId));
    const settlements = await tx.select().from(schema.settlements).where(eq(schema.settlements.gameId, gameId));
    // Open debts between tonight's players, for the settlement preview.
    const open = await tx
      .select({ from: schema.settlements.fromPlayer, to: schema.settlements.toPlayer, amount: schema.settlements.amount })
      .from(schema.settlements)
      .innerJoin(schema.games, eq(schema.games.id, schema.settlements.gameId))
      .where(
        and(
          eq(schema.games.homeId, game.homeId),
          eq(schema.games.status, "closed"),
          notExists(tx.select({ x: sql`1` }).from(schema.debtPayments).where(eq(schema.debtPayments.settlementId, schema.settlements.id))),
        ),
      );
    return { game, home: home!, players, entries, settlements, open, userId: user.id };
  });
  if (!data) notFound();
  const { game, home, players, entries, settlements, open, userId } = data;
  const name = new Map(players.map((p) => [p.id, p.displayName]));
  const byId = new Map(players.map((p) => [p.id, p]));
  const money = (n: number, signed = false) => formatAmount(n, home, locale, signed);
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

  return (
    <>
      <p className="small">
        <Link href={`/homes/${home.id}`}>← {home.name}</Link>
      </p>
      <h1>
        {game.number ? t("title", { number: new Intl.NumberFormat(locale).format(game.number) }) : t("untitled")}{" "}
        <span className={`badge ${game.status === "closed" ? "closed" : "live"}`}>{t(`status_${status}`)}</span>
      </h1>
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
              return (
                <tr key={e.playerId}>
                  <td>
                    {name.get(e.playerId)} {e.confirmedAt && <span className="badge">✓</span>}
                  </td>
                  <td className="end num">
                    {money(e.totalIn)}
                    {canWrite && (
                      <form action={rebuyAction} style={{ display: "inline", marginInlineStart: 8 }}>
                        <input type="hidden" name="gameId" value={game.id} />
                        <input type="hidden" name="playerId" value={e.playerId} />
                        <button className="btn small secondary" type="submit" title={money(game.defaultBuyIn)}>
                          + {t("rebuy")}
                        </button>
                      </form>
                    )}
                  </td>
                  <td className="end">
                    {canWrite ? (
                      <form action={cashOutAction} className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        <input type="hidden" name="gameId" value={game.id} />
                        <input type="hidden" name="playerId" value={e.playerId} />
                        <input
                          name="cashOut"
                          inputMode="decimal"
                          defaultValue={toInputValue(e.cashOut, home.unitDivisor)}
                          style={{ maxWidth: 110 }}
                          dir="ltr"
                          aria-label={t("cashOut")}
                        />
                        <button className="btn small" type="submit">
                          {t("save")}
                        </button>
                      </form>
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

        {canWrite && (
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

      {game.status !== "closed" && myEntry && !myEntry.confirmedAt && (
        <form action={confirmResultAction} style={{ marginBlockEnd: 16 }}>
          <input type="hidden" name="gameId" value={game.id} />
          <button className="btn secondary" type="submit">
            {t("confirmMine")}
          </button>
        </form>
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
        <p className="small muted">
          {t("fingerprint")}: <span className="mono">{game.hash}</span>
        </p>
      )}
    </>
  );
}
