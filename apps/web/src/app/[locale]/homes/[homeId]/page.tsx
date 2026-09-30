import { AVATARS, activeInvites, ledger, memberList, schema } from "@poker/db";
import { asc, desc, eq } from "@poker/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { addPlayerAction, createInviteAction, houseRulesAction, markPaidAction, newGameAction } from "@/app/actions/homes";
import { mergePlayersAction, playerProfileAction, removeMemberAction, revokeInviteAction } from "@/app/actions/players";
import { connectGroupAction, disconnectGroupAction } from "@/app/actions/telegram";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PlayerName } from "@/components/PlayerName";
import { CopyButton } from "@/components/live";
import { Link } from "@/i18n/navigation";
import { sha256 } from "@/lib/crypto";
import { formatAmount, formatDate } from "@/lib/format";
import { appOrigin, inviteToken, qrDataUrl } from "@/lib/live";
import { openPayment } from "@/lib/payment";
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
  const tp = await getTranslations("people");

  const data = await withUser(async (tx, user) => {
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, homeId));
    if (!home) return null;
    const players = await tx.select().from(schema.players).where(eq(schema.players.homeId, homeId)).orderBy(asc(schema.players.displayName));
    const games = await tx.select().from(schema.games).where(eq(schema.games.homeId, homeId)).orderBy(desc(schema.games.createdAt));
    const debts = await ledger(tx, homeId);
    const members = await memberList(tx, homeId);
    const isOwner = home.ownerId === user.id;
    const invites = isOwner ? await activeInvites(tx, homeId) : [];
    return { home, players, games, debts, members, invites, isOwner, userId: user.id };
  });
  if (!data) notFound();
  const { home, players, games, debts, members, isOwner, userId } = data;
  const name = new Map(players.map((p) => [p.id, p.displayName]));
  const byId = new Map(players.map((p) => [p.id, p]));
  const active = players.filter((p) => !p.mergedInto);
  // Decrypted on the server, for members of this home only (RLS returned these rows).
  const payment = new Map(players.map((p) => [p.id, openPayment(p.paymentInfoEnc)]));
  const money = (n: number) => formatAmount(n, home, locale);
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  const canWrite = isOwner && !home.readOnly;
  const canEdit = (p: (typeof players)[number]) => canWrite || p.userId === userId;
  const origin = await appOrigin();
  // Links made with the HMAC scheme can be shown again; older random-token links cannot.
  const invites = await Promise.all(
    data.invites.map(async (i) => {
      const token = inviteToken(i.id);
      const url = sha256(token).equals(Buffer.from(i.tokenHash)) ? `${origin}/${locale}/invite/${token}` : null;
      return { ...i, url, qr: url ? await qrDataUrl(url) : null };
    }),
  );

  return (
    <>
      <h1>{home.name}</h1>
      <ErrorNotice code={error} />
      {home.readOnly && <div className="alert">{t("readOnly")}</div>}

      <div className="grid">
        <section className="card">
          <h2>{t("games")}</h2>
          {canWrite && (
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

        <section className="card" id="players">
          <h2>{t("players")}</h2>
          <ul className="plain player-list">
            {active.map((p) => (
              <li key={p.id}>
                <PlayerName name={p.displayName} avatar={p.avatar} /> {p.userId && <span className="badge">✓</span>}
                {canEdit(p) && (
                  <details className="player-edit">
                    <summary>{tp("editPlayer")}</summary>
                    <form action={playerProfileAction} className="stack">
                      <input type="hidden" name="homeId" value={home.id} />
                      <input type="hidden" name="playerId" value={p.id} />
                      <fieldset className="avatar-picker">
                        <legend>{tp("avatar")}</legend>
                        <label>
                          <input type="radio" name="avatar" value="" defaultChecked={!p.avatar} />
                          <span>{tp("noAvatar")}</span>
                        </label>
                        {AVATARS.map((a) => (
                          <label key={a}>
                            <input type="radio" name="avatar" value={a} defaultChecked={p.avatar === a} />
                            <span>{a}</span>
                          </label>
                        ))}
                      </fieldset>
                      <label>
                        {tp("paymentInfo")}
                        <textarea name="paymentInfo" rows={2} maxLength={200} dir="auto" defaultValue={payment.get(p.id) ?? ""} />
                      </label>
                      <p className="small muted">{tp("paymentHint")}</p>
                      <div>
                        <button className="btn small secondary" type="submit">
                          {tp("save")}
                        </button>
                      </div>
                    </form>
                  </details>
                )}
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
                {debts.map((d) => {
                  const info = payment.get(d.to);
                  return (
                    <tr key={d.settlementId}>
                      <td>
                        {byId.get(d.from)?.avatar && (
                          <span className="avatar" aria-hidden="true">
                            {byId.get(d.from)?.avatar}
                          </span>
                        )}
                        {tg("pays", { from: name.get(d.from) ?? "?", to: name.get(d.to) ?? "?" })}
                      </td>
                      <td className="end num">{money(d.amount)}</td>
                      <td className="muted small">#{d.gameNumber === null ? "" : new Intl.NumberFormat(locale).format(d.gameNumber)}</td>
                      <td>
                        {info ? (
                          <span className="pay-info">
                            <span className="mono small" dir="ltr">
                              {info}
                            </span>
                            <CopyButton text={info} label={tp("copy")} done={tp("copied")} />
                          </span>
                        ) : (
                          <span className="muted small">{tp("noPaymentInfo")}</span>
                        )}
                      </td>
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
                  );
                })}
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

      <section className="card" id="members">
        <h2>{tp("membersTitle")}</h2>
        <ul className="plain stack">
          {members.map((m) => (
            <li key={m.userId} className="row member-row">
              <span>
                <PlayerName name={m.name || tp("noName")} avatar={m.playerId ? byId.get(m.playerId)?.avatar : null} />{" "}
                <span className="badge">{m.role === "owner" ? t("owner") : t("member")}</span>{" "}
                {m.userId === userId && <span className="muted small">({tp("you")}) </span>}
                <span className="muted small">{tp("joined", { date: formatDate(m.joinedAt, locale) })}</span>
              </span>
              {isOwner && m.role === "member" && (
                <form action={removeMemberAction}>
                  <input type="hidden" name="homeId" value={home.id} />
                  <input type="hidden" name="userId" value={m.userId} />
                  <button className="btn small danger" type="submit">
                    {tp("remove")}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
        {isOwner && <p className="small muted">{tp("removeHint")}</p>}
      </section>

      {isOwner && (
        <section className="card stack" id="invites">
          <h2>{tp("invitesTitle")}</h2>
          {invites.length === 0 ? (
            <p className="muted">{tp("invitesNone")}</p>
          ) : (
            <ul className="plain stack">
              {invites.map((i) => (
                <li key={i.id} className="invite-row stack">
                  <div className="row member-row">
                    <span>
                      <strong>{i.playerId ? tp("inviteFor", { name: name.get(i.playerId) ?? "?" }) : tp("inviteAnyone")}</strong>{" "}
                      <span className="muted small">
                        {tp("inviteUses", { uses: num(i.uses), max: num(i.maxUses) })} ·{" "}
                        {tp("inviteExpires", { date: formatDate(i.expiresAt, locale, true) })}
                      </span>
                    </span>
                    <form action={revokeInviteAction}>
                      <input type="hidden" name="homeId" value={home.id} />
                      <input type="hidden" name="inviteId" value={i.id} />
                      <button className="btn small secondary" type="submit">
                        {tp("revoke")}
                      </button>
                    </form>
                  </div>
                  {i.url && i.qr ? (
                    <>
                      <div className="row invite-link">
                        <span className="mono small" dir="ltr">
                          {i.url}
                        </span>
                        <CopyButton text={i.url} label={tp("copyLink")} done={tp("copied")} />
                      </div>
                      <details>
                        <summary>{tp("inviteShowQr")}</summary>
                        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL drawn on the server */}
                        <img className="invite-qr" src={i.qr} width={260} height={260} alt={tp("inviteQrAlt")} />
                      </details>
                    </>
                  ) : (
                    <p className="small muted">{tp("inviteLegacy")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canWrite && (
            <form action={createInviteAction} className="row">
              <input type="hidden" name="homeId" value={home.id} />
              <label>
                {tp("inviteForPlayer")}
                <select name="playerId" style={{ width: "auto" }}>
                  <option value="">{tp("inviteAnyone")}</option>
                  {active
                    .filter((p) => !p.userId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {tp("inviteMaxUses")}
                <select name="maxUses" style={{ width: "auto" }} defaultValue="1">
                  {[1, 5, 20].map((n) => (
                    <option key={n} value={n}>
                      {num(n)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn secondary" type="submit">
                {t("inviteCreate")}
              </button>
            </form>
          )}
        </section>
      )}

      {canWrite && active.length >= 2 && (
        <section className="card stack" id="merge">
          <h2>{tp("mergeTitle")}</h2>
          <p className="small muted">{tp("mergeHint")}</p>
          <form action={mergePlayersAction} className="row">
            <input type="hidden" name="homeId" value={home.id} />
            <label>
              {tp("mergeKeep")}
              <select name="keepId" required style={{ width: "auto" }}>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tp("mergeDuplicate")}
              <select name="duplicateId" required style={{ width: "auto" }} defaultValue={active[1]!.id}>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn danger" type="submit">
              {tp("mergeButton")}
            </button>
          </form>
        </section>
      )}
    </>
  );
}
