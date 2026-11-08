import { ledger, schema } from "@poker/db";
import { eq } from "@poker/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PlayerName } from "@/components/PlayerName";
import { PrintButton } from "@/components/PrintButton";
import { Link } from "@/i18n/navigation";
import { formatAmount, formatDate } from "@/lib/format";
import { openPayment } from "@/lib/payment";
import { pdfEnabled } from "@/lib/pdf";
import { withUser } from "@/lib/session";

/**
 * The unpaid-debts view: who still has to pay whom, and how much — printable as a tidy one-page
 * PDF (with amounts and names) so it is clear at the table who owes what to whom. Payment
 * details of each payee are included, decrypted on the server for members of this home only.
 */
export default async function DebtsPage({
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
  const ti = await getTranslations("ideas");
  const tp = await getTranslations("people");

  const data = await withUser(async (tx) => {
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, homeId));
    if (!home) return null;
    const players = await tx.select().from(schema.players).where(eq(schema.players.homeId, homeId));
    return { home, players, debts: await ledger(tx, homeId) };
  });
  if (!data) notFound();
  const { home, players, debts } = data;
  const byId = new Map(players.map((p) => [p.id, p]));
  const payment = new Map(players.map((p) => [p.id, openPayment(p.paymentInfoEnc)]));
  const money = (n: number) => formatAmount(n, { currency: home.currency, unitSuffix: home.unitSuffix, unitDivisor: home.unitDivisor }, locale);
  const num = new Intl.NumberFormat(locale);
  // One row per payer: their debts grouped and summed, so the summary says what each person
  // still owes in total instead of repeating them once per debt.
  const byPayer = new Map<string, { total: number; count: number }>();
  for (const d of debts) {
    const g = byPayer.get(d.from) ?? { total: 0, count: 0 };
    g.total += d.amount;
    g.count++;
    byPayer.set(d.from, g);
  }
  const total = debts.reduce((a, d) => a + d.amount, 0);
  const today = formatDate(new Date(), locale);

  return (
    <>
      <p className="small no-print">
        <Link href={`/homes/${home.id}`}>← {home.name}</Link>
      </p>
      <div className="row no-print" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>{t("ledger")}</h1>
        <div className="row">
          {pdfEnabled() && (
            <a className="btn secondary small" href={`/api/homes/${home.id}/pdf?view=debts&locale=${locale}`}>
              {t("downloadPdf")}
            </a>
          )}
          <PrintButton label={t("print")} />
        </div>
      </div>
      <ErrorNotice code={error} />

      {debts.length === 0 ? (
        <section className="card">
          <p className="muted">{t("noDebts")}</p>
        </section>
      ) : (
        <>
          {/* Print header: the sheet must make sense on its own, without the site around it. */}
          <header className="print-head">
            <h1>{home.name}</h1>
            <p className="small muted">
              {t("debtsSheetTitle")} · {today}
            </p>
          </header>

          <section className="card table-wrap debts-sheet">
            <table className="data">
              <thead>
                <tr>
                  <th>{t("debtsPayer")}</th>
                  <th>{t("debtsPayee")}</th>
                  <th className="end">{t("debtsAmount")}</th>
                  <th className="end">{t("debtsFromGame")}</th>
                  <th>{t("debtsPayTo")}</th>
                </tr>
              </thead>
              <tbody>
                {debts.map((d) => {
                  const info = payment.get(d.to);
                  return (
                    <tr key={d.settlementId}>
                      <td>
                        <PlayerName name={byId.get(d.from)?.displayName ?? "?"} avatar={byId.get(d.from)?.avatar} />
                      </td>
                      <td>
                        <PlayerName name={byId.get(d.to)?.displayName ?? "?"} avatar={byId.get(d.to)?.avatar} />
                      </td>
                      <td className="end num">
                        <strong>{money(d.amount)}</strong>
                        {d.amount !== d.original && (
                          <span className="small muted"> {ti("ofOriginal", { original: money(d.original) })}</span>
                        )}
                      </td>
                      <td className="end num">{d.gameNumber === null ? "" : `#${num.format(d.gameNumber)}`}</td>
                      <td className="small">
                        {info ? (
                          <span className="mono" dir="ltr">
                            {info}
                          </span>
                        ) : (
                          <span className="muted">{tp("noPaymentInfo")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>{t("debtsTotal")}</td>
                  <td className="end num">
                    <strong>{money(total)}</strong>
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </section>

          {byPayer.size > 0 && (
            <section className="card debts-summary">
              <h2>{t("debtsSummary")}</h2>
              <ul className="plain stack">
                {[...byPayer.entries()]
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([payerId, g]) => (
                    <li key={payerId} className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <span>
                        <PlayerName name={byId.get(payerId)?.displayName ?? "?"} avatar={byId.get(payerId)?.avatar} />{" "}
                        <span className="muted small">{t("debtsCount", { count: num.format(g.count) })}</span>
                      </span>
                      <span className="loss num">
                        <strong>{money(g.total)}</strong>
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="small muted">{t("ledgerWhoConfirms")}</p>
            </section>
          )}
        </>
      )}
    </>
  );
}
