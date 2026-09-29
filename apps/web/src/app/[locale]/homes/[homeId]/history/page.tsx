import { history, historyQuery, schema } from "@poker/db";
import { eq } from "@poker/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { formatAmount, formatDate, normalizeDigits, parseAmount } from "@/lib/format";
import { withUser } from "@/lib/session";

type Search = { player?: string; from?: string; to?: string; number?: string; outcome?: string; min?: string };

export default async function History({ params, searchParams }: { params: Promise<{ homeId: string }>; searchParams: Promise<Search> }) {
  const { homeId } = await params;
  const q = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(homeId)) notFound();
  const locale = await getLocale();
  const t = await getTranslations("history");
  const tg = await getTranslations("game");

  const result = await withUser(async (tx) => {
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, homeId));
    if (!home) return null;
    const num = q.number ? Number(normalizeDigits(q.number)) : undefined;
    const minAbs = q.min ? parseAmount(q.min, home.unitDivisor) ?? undefined : undefined;
    const parsed = historyQuery.safeParse({
      homeIds: [homeId],
      player: q.player || undefined,
      from: q.from || undefined,
      to: q.to ? `${q.to}T23:59:59.999Z` : undefined,
      number: Number.isInteger(num) && num! > 0 ? num : undefined,
      outcome: ["win", "loss", "even"].includes(q.outcome ?? "") ? q.outcome : undefined,
      minAbs,
      limit: 500,
    });
    const rows = parsed.success ? await history(tx, parsed.data) : [];
    return { home, rows };
  });
  if (!result) notFound();
  const { home, rows } = result;
  const money = (n: number, signed = false) => formatAmount(n, home, locale, signed);

  return (
    <>
      <p className="small">
        <Link href={`/homes/${home.id}`}>← {home.name}</Link>
      </p>
      <h1>{t("title")}</h1>
      <form className="card grid" method="get">
        <label>
          {t("player")}
          <input name="player" defaultValue={q.player} maxLength={40} />
        </label>
        <label>
          {t("from")}
          <input type="date" name="from" defaultValue={q.from} />
        </label>
        <label>
          {t("to")}
          <input type="date" name="to" defaultValue={q.to} />
        </label>
        <label>
          {t("number")}
          <input name="number" inputMode="numeric" defaultValue={q.number} dir="ltr" />
        </label>
        <label>
          {t("outcome")}
          <select name="outcome" defaultValue={q.outcome ?? ""}>
            <option value="">{t("any")}</option>
            <option value="win">{t("win")}</option>
            <option value="loss">{t("loss")}</option>
            <option value="even">{t("even")}</option>
          </select>
        </label>
        <label>
          {t("minAmount")}
          <input name="min" inputMode="decimal" defaultValue={q.min} dir="ltr" />
        </label>
        <div>
          <button className="btn" type="submit">
            {t("search")}
          </button>
        </div>
      </form>

      <section className="card table-wrap">
        {rows.length === 0 ? (
          <p className="muted">{t("empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("date")}</th>
                <th>#</th>
                <th>{tg("player")}</th>
                <th className="end">{tg("in")}</th>
                <th className="end">{tg("net")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.gameId}-${r.playerId}`}>
                  <td className="small">{r.closedAt ? formatDate(r.closedAt, locale) : ""}</td>
                  <td>
                    <Link href={`/games/${r.gameId}`}>{r.number === null ? "" : new Intl.NumberFormat(locale).format(r.number)}</Link>
                  </td>
                  <td>{r.player}</td>
                  <td className="end num">{money(r.totalIn)}</td>
                  <td className={`end num ${r.net > 0 ? "win" : r.net < 0 ? "loss" : ""}`}>{money(r.net, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
