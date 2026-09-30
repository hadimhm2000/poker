import { adminViewHome, asAuth } from "@poker/db";
import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireAdmin } from "@/lib/admin";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";

export const metadata = { robots: { index: false } };

/** Read-only view of one home under an open support grant (each view is logged). */
export default async function AdminHome({ params }: { params: Promise<{ homeId: string }> }) {
  const admin = await requireAdmin();
  const { homeId } = await params;
  const locale = await getLocale();
  const t = await getTranslations("admin");
  const view = /^[0-9a-f-]{36}$/i.test(homeId)
    ? await asAuth(getDb(), (tx) => adminViewHome(tx, admin.id, homeId)).catch(() => null)
    : null;
  if (!view) {
    return (
      <>
        <h1>{t("title")}</h1>
        <div className="alert">{t("noAccess")}</div>
        <Link href="/admin">{t("back")}</Link>
      </>
    );
  }
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  return (
    <>
      <p>
        <Link href="/admin">{t("back")}</Link>
      </p>
      <h1>{view.name}</h1>
      <div className="alert">{t("accessUntil", { until: formatDate(new Date(view.until), locale, true) })}</div>
      <p className="small">
        {t("homeLine", { owner: view.owner ?? "—", members: view.members, players: view.players })}
        {view.deletedAt && <span className="badge">{t("deleted")}</span>}
      </p>
      {view.games.map((g, i) => (
        <section key={i} className="card stack">
          <h3>
            #{g.number ?? "—"} · {g.status} {g.closedAt && `· ${formatDate(new Date(g.closedAt), locale, true)}`}
          </h3>
          {g.hash && (
            <div className="small mono break" dir="ltr">
              {g.hash}
            </div>
          )}
          <table className="table small">
            <tbody>
              {g.entries.map((e, j) => (
                <tr key={j}>
                  <td>{e.player}</td>
                  <td className="num">{num(e.in)}</td>
                  <td className="num">{e.out == null ? "—" : num(e.out)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
