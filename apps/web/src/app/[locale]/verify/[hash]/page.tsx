import { asAuth, verifyByHash } from "@poker/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getDb } from "@/lib/db";
import { formatAmount, formatDate } from "@/lib/format";

// Reached from the QR on a result card. Public: holding the 256-bit hash is the permission.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function VerifyPage({ params }: { params: Promise<{ locale: string; hash: string }> }) {
  const { locale, hash } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("verify");
  const v = /^[0-9a-f]{64}$/.test(hash) ? await asAuth(getDb(), (tx) => verifyByHash(tx, hash)) : null;
  if (!v) notFound();
  const ok = v.gameIntact && v.chainIntact;
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  const money = (n: number, signed = false) => formatAmount(n, v, locale, signed);

  return (
    <>
      <h1>{t("title")}</h1>
      <div className={`alert ${ok ? "ok" : ""}`} role="status">
        <strong>{ok ? t("ok") : v.gameIntact ? t("chainBroken") : t("changed")}</strong>
        <div className="small">{ok ? t("okBody", { count: num(v.chainLength) }) : t("brokenBody")}</div>
      </div>

      <section className="card table-wrap">
        <h2>
          {v.homeName} · {t("game", { number: num(v.number) })}
        </h2>
        <p className="small muted">{t("closedAt", { when: formatDate(v.closedAt, locale, true) })}</p>
        <table>
          <thead>
            <tr>
              <th>{t("player")}</th>
              <th className="end">{t("in")}</th>
              <th className="end">{t("out")}</th>
              <th className="end">{t("net")}</th>
            </tr>
          </thead>
          <tbody>
            {v.entries.map((e, i) => (
              <tr key={i}>
                <td>{e.name}</td>
                <td className="end num">{money(e.totalIn)}</td>
                <td className="end num">{money(e.cashOut)}</td>
                <td className={`end num ${e.net > 0 ? "win" : e.net < 0 ? "loss" : ""}`}>
                  <strong>{money(e.net, true)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card stack">
        <h2>{t("howTitle")}</h2>
        <p className="small">{t("howBody")}</p>
        <dl className="small">
          <dt>{t("hash")}</dt>
          <dd>
            <code dir="ltr" className="break">
              {v.hash}
            </code>
          </dd>
          <dt>{t("prevHash")}</dt>
          <dd>
            <code dir="ltr" className="break">
              {v.prevHash}
            </code>
          </dd>
        </dl>
        <details>
          <summary>{t("payload")}</summary>
          <p className="small muted">{t("payloadNote")}</p>
          <pre dir="ltr" className="break small">{`sha256( "${v.prevHash}" + "\\n" + ${v.payload} )`}</pre>
        </details>
      </section>
    </>
  );
}
