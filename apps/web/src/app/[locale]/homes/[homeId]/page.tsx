import { homePlan, ledger, schema } from "@poker/db";
import { asc, desc, eq, sql } from "@poker/db";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { addPlayerAction, createInviteAction, houseRulesAction, markPaidAction, newGameAction } from "@/app/actions/homes";
import { connectGroupAction, disconnectGroupAction } from "@/app/actions/telegram";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Link } from "@/i18n/navigation";
import { formatAmount, formatDate } from "@/lib/format";
import { appOrigin } from "@/lib/live";
import { withUser } from "@/lib/session";
import { telegramConfigured } from "@/telegram/instance";

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ homeId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { homeId } = await params;
  const { error } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(homeId)) notFound();
  const locale = await getLocale();
  const t = await getTranslations("homes");
  const tg = await getTranslations("game");
  const ts = await getTranslations("stats");
  const tn = await getTranslations("nights");
  const tt = await getTranslations("telegram");
  const tr = await getTranslations("rules");
  const tb = await getTranslations("billing");
  const invite = (await cookies()).get("invite_flash")?.value;

  const data = await withUser(async (tx, user) => {
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, homeId));
    if (!home) return null;
    const players = await tx.select().from(schema.players).where(eq(schema.players.homeId, homeId)).orderBy(asc(schema.players.displayName));
    const games = await tx.select().from(schema.games).where(eq(schema.games.homeId, homeId)).orderBy(desc(schema.games.createdAt));
    const debts = await ledger(tx, homeId);
    // Free plan: 3 games in total across the owner's homes (the trigger enforces it; this
    // only swaps the "New game" form for the upgrade note).
    let atGameLimit = false;
    if (home.ownerId === user.id && (await homePlan(tx, homeId)) === "free") {
      const [c] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.games)
        .innerJoin(schema.homes, eq(schema.homes.id, schema.games.homeId))
        .where(eq(schema.homes.ownerId, user.id));
      atGameLimit = (c?.n ?? 0) >= 3;
    }
    return { home, players, games, debts, isOwner: home.ownerId === user.id, userId: user.id, atGameLimit };
  });
  if (!data) notFound();
  const { home, players, games, debts, isOwner, atGameLimit } = data;
  const name = new Map(players.map((p) => [p.id, p.displayName]));
  const money = (n: number) => formatAmount(n, home, locale);
  const canWrite = isOwner && !home.readOnly;
  const origin = await appOrigin();

  return (
    <>
      <h1>{home.name}</h1>
      <ErrorNotice code={error} />
      {home.readOnly && (
        <div className="alert">
          {t("readOnly")} {isOwner && <Link href="/pricing">{tb("upgradeLink")}</Link>}
        </div>
      )}

      <div className="grid">
        <section className="card">
          <h2>{t("games")}</h2>
          {canWrite && atGameLimit && (
            <p className="alert">
              {t("gameLimit")} <Link href="/pricing">{tb("upgradeLink")}</Link>
            </p>
          )}
          {canWrite && !atGameLimit && (
            <form action={newGameAction} className="row" style={{ marginBlockEnd: 12 }}>
              <input type="hidden" name="homeId" value={home.id} />
              <label style={{ flex: 1 }}>
                {t("defaultBuyIn")}
                <input name="defaultBuyIn" inputMode="decimal" required dir="ltr" />
              </label>
              <button className="btn" type="submit">
                {t("newGame")}
              </button>
            </form>
          )}
          <ul style={{ paddingInlineStart: 18, margin: 0 }}>
            {games.map((g) => (
              <li key={g.id}>
                <Link href={`/games/${g.id}`}>
                  {g.number ? tg("title", { number: new Intl.NumberFormat(locale).format(g.number) }) : tg("untitled")}
                </Link>{" "}
                <span className={`badge ${g.status}`}>{tg(`status_${g.status}`)}</span>{" "}
                <span className="muted small">{formatDate(g.closedAt ?? g.createdAt, locale)}</span>
              </li>
            ))}
          </ul>
          <p style={{ marginBlockEnd: 0 }}>
            <Link href={`/homes/${home.id}/history`}>{t("history")}</Link> ·{" "}
            <Link href={`/homes/${home.id}/stats`}>{ts("title")}</Link> ·{" "}
            <Link href={`/homes/${home.id}/nights`}>{tn("title")}</Link> ·{" "}
            <Link href={`/rules?home=${home.id}`}>{t("rules")}</Link>
            {canWrite && (
              <>
                {" "}
                · <Link href={`/homes/${home.id}/import`}>{ts("import")}</Link>
              </>
            )}
          </p>
        </section>

        <section className="card">
          <h2>{t("players")}</h2>
          <ul style={{ paddingInlineStart: 18 }}>
            {players.filter((p) => !p.mergedInto).map((p) => (
              <li key={p.id}>
                {p.displayName} {p.userId && <span className="badge">✓</span>}
              </li>
            ))}
          </ul>
          {canWrite && (
            <form action={addPlayerAction} className="row">
              <input type="hidden" name="homeId" value={home.id} />
              <label style={{ flex: 1 }}>
                {t("playerName")}
                <input name="name" required maxLength={40} />
              </label>
              <button className="btn secondary" type="submit">
                {t("addPlayer")}
              </button>
            </form>
          )}
        </section>
      </div>

      <section className="card">
        <h2>{t("ledger")}</h2>
        {debts.length === 0 ? (
          <p className="muted">{t("noDebts")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {debts.map((d) => (
                  <tr key={d.settlementId}>
                    <td>{tg("pays", { from: name.get(d.from) ?? "?", to: name.get(d.to) ?? "?" })}</td>
                    <td className="end num">{money(d.amount)}</td>
                    <td className="muted small">#{d.gameNumber === null ? "" : new Intl.NumberFormat(locale).format(d.gameNumber)}</td>
                    <td className="end">
                      <form action={markPaidAction}>
                        <input type="hidden" name="homeId" value={home.id} />
                        <input type="hidden" name="settlementId" value={d.settlementId} />
                        <button className="btn small secondary" type="submit">
                          {t("markPaid")}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack">
        <h2>{tr("houseTitle")}</h2>
        {canWrite ? (
          <form action={houseRulesAction} className="stack">
            <input type="hidden" name="homeId" value={home.id} />
            <label>
              {tr("houseEdit")}
              <textarea name="houseRules" defaultValue={home.houseRules} maxLength={2000} rows={4} />
            </label>
            <p className="small muted">{tr("houseHint")}</p>
            <div>
              <button className="btn secondary" type="submit">
                {tr("houseSave")}
              </button>
            </div>
          </form>
        ) : home.houseRules ? (
          <p className="house-rules">{home.houseRules}</p>
        ) : (
          <p className="muted">{tr("houseNone")}</p>
        )}
      </section>

      {canWrite && telegramConfigured() && (
        <section className="card stack">
          <h2>{tt("groupTitle")}</h2>
          {home.telegramChatId ? (
            <>
              <p>{tt("groupLinked")}</p>
              <form action={disconnectGroupAction}>
                <input type="hidden" name="homeId" value={home.id} />
                <button className="btn secondary" type="submit">
                  {tt("disconnect")}
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="muted">{tt("groupNotLinked")}</p>
              <form action={connectGroupAction}>
                <input type="hidden" name="homeId" value={home.id} />
                <button className="btn" type="submit">
                  {tt("connectGroup")}
                </button>
              </form>
              <p className="small muted">{tt("groupHint")}</p>
            </>
          )}
        </section>
      )}

      {canWrite && (
        <section className="card stack">
          <h2>{t("invite")}</h2>
          {invite && (
            <>
              <p className="small muted">{t("inviteHint")}</p>
              <p className="mono">{`${origin}/${locale}/invite/${invite}`}</p>
            </>
          )}
          <form action={createInviteAction} className="row">
            <input type="hidden" name="homeId" value={home.id} />
            <select name="playerId" style={{ width: "auto" }} aria-label={t("players")}>
              <option value="">—</option>
              {players.filter((p) => !p.userId && !p.mergedInto).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <button className="btn secondary" type="submit">
              {t("inviteCreate")}
            </button>
          </form>
        </section>
      )}
    </>
  );
}
