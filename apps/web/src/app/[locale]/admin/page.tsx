import { adminFindUsers, adminOverview, adminRecent, asAuth } from "@poker/db";
import { getLocale, getTranslations } from "next-intl/server";
import { adminEndSessionsAction, adminOpenHomeAction, adminSetPlanAction } from "@/app/actions/admin";
import { requireAdmin } from "@/lib/admin";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";

export const metadata = { robots: { index: false } };

const ERRORS = ["REASON", "NOT_FOUND", "ERROR", "FORBIDDEN"] as const;

/** Limited support panel: counts, account lookup, and time-boxed, logged access to one home. */
export default async function Admin({ searchParams }: { searchParams: Promise<{ q?: string; error?: string; done?: string }> }) {
  const admin = await requireAdmin();
  const locale = await getLocale();
  const t = await getTranslations("admin");
  const q = (await searchParams).q?.trim().slice(0, 254) ?? "";
  const { error, done } = await searchParams;
  const { overview, users, log } = await asAuth(getDb(), async (tx) => ({
    overview: await adminOverview(tx, admin.id),
    users: q ? await adminFindUsers(tx, admin.id, q) : [],
    log: await adminRecent(tx, admin.id, 30),
  }));
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  const e = ERRORS.find((x) => x === error) ?? (error ? "ERROR" : null);

  return (
    <>
      <h1>{t("title")}</h1>
      <p className="small muted">{t("intro")}</p>
      {e && <div className="alert">{t(`errors.${e}`)}</div>}
      {done && <div className="alert ok">{t("done")}</div>}

      <section className="grid">
        {(["users", "usersNew30d", "pro", "homes", "gamesClosed", "gamesClosed30d", "twoFactor", "telegram"] as const).map((k) => (
          <div key={k} className="card">
            <div className="small muted">{t(`stats.${k}`)}</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{num(overview[k])}</div>
          </div>
        ))}
      </section>

      <section className="card stack" style={{ marginBlockStart: 16 }}>
        <h2>{t("findTitle")}</h2>
        <form className="row" role="search">
          <input className="grow" name="q" defaultValue={q} placeholder={t("findPlaceholder")} dir="ltr" minLength={3} />
          <button className="btn small" type="submit">
            {t("find")}
          </button>
        </form>
        {q && users.length === 0 && <p className="muted">{t("noUsers")}</p>}
        {users.map((u) => (
          <article key={u.id} className="stack" style={{ borderBlockStart: "1px solid var(--border)", paddingBlockStart: 10 }}>
            <div>
              <strong dir="ltr">{u.email ?? "—"}</strong> · {u.display_name || "—"}{" "}
              {u.deleted && <span className="badge">{t("deleted")}</span>}
            </div>
            <div className="small muted">
              {t("userLine", {
                created: formatDate(new Date(u.created_at), locale),
                plan: u.plan,
                homes: u.homes_owned,
                memberships: u.memberships,
              })}{" "}
              · {u.two_factor ? t("twoFactorOn") : t("twoFactorOff")} · {u.telegram ? "Telegram" : ""}
            </div>
            <div className="small mono" dir="ltr">
              {u.id}
            </div>
            {!u.deleted && (
              <form className="row" action={adminSetPlanAction}>
                <input type="hidden" name="userId" value={u.id} />
                <input type="hidden" name="q" value={q} />
                <select name="plan" defaultValue={u.plan}>
                  <option value="free">free</option>
                  <option value="pro">pro</option>
                </select>
                <input className="grow" name="reason" placeholder={t("reason")} required minLength={5} maxLength={500} />
                <button className="btn small secondary" type="submit">
                  {t("setPlan")}
                </button>
                <button className="btn small danger" type="submit" formAction={adminEndSessionsAction}>
                  {t("endSessions")}
                </button>
              </form>
            )}
          </article>
        ))}
      </section>

      <section className="card stack" style={{ marginBlockStart: 16 }}>
        <h2>{t("openTitle")}</h2>
        <p className="small muted">{t("openNote")}</p>
        <form className="stack" action={adminOpenHomeAction}>
          <label>
            {t("homeId")}
            <input name="homeId" required pattern="[0-9a-fA-F-]{36}" dir="ltr" />
          </label>
          <label>
            {t("reason")}
            <input name="reason" required minLength={5} maxLength={500} placeholder={t("reasonExample")} />
          </label>
          <div>
            <button className="btn small" type="submit">
              {t("open")}
            </button>
          </div>
        </form>
      </section>

      <section className="card" style={{ marginBlockStart: 16 }}>
        <h2>{t("logTitle")}</h2>
        <table className="table small">
          <tbody>
            {log.map((l, i) => (
              <tr key={i}>
                <td>{formatDate(new Date(l.at), locale, true)}</td>
                <td dir="ltr">{l.actor_email ?? "—"}</td>
                <td className="mono">{l.action.replace(/^admin:/, "")}</td>
                <td className="mono break" dir="ltr">
                  {[l.target, l.details ? JSON.stringify(l.details) : ""].filter(Boolean).join(" ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
