import { schema } from "@poker/db";
import { asc, isNull } from "@poker/db";
import { getTranslations } from "next-intl/server";
import { createHomeAction } from "@/app/actions/homes";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Link } from "@/i18n/navigation";
import { localeNames, locales } from "@/i18n/routing";
import { withUser } from "@/lib/session";

export default async function Homes({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const t = await getTranslations("homes");
  const rows = await withUser((tx, user) =>
    tx
      .select({ id: schema.homes.id, name: schema.homes.name, ownerId: schema.homes.ownerId, readOnly: schema.homes.readOnly })
      .from(schema.homes)
      .where(isNull(schema.homes.deletedAt))
      .orderBy(asc(schema.homes.createdAt))
      .then((homes) => homes.map((h) => ({ ...h, mine: h.ownerId === user.id }))),
  );

  return (
    <>
      <h1>{t("title")}</h1>
      <ErrorNotice code={error} />
      {rows.length === 0 && <p className="muted">{t("empty")}</p>}
      <div className="grid">
        {rows.map((h) => (
          <Link key={h.id} href={`/homes/${h.id}`} className="card" style={{ color: "inherit" }}>
            <h3 style={{ marginBlockEnd: 4 }}>{h.name}</h3>
            <span className="badge">{h.mine ? t("owner") : t("member")}</span>{" "}
            {h.readOnly && <span className="badge">{t("readOnly")}</span>}
          </Link>
        ))}
      </div>

      <section className="card" style={{ marginBlockStart: 24 }}>
        <h2>{t("create")}</h2>
        <form action={createHomeAction} className="grid">
          <label>
            {t("name")}
            <input name="name" required maxLength={60} />
          </label>
          <label>
            {t("currency")}
            <input name="currency" maxLength={3} pattern="[A-Za-z]{3}" dir="ltr" />
          </label>
          <label>
            {t("unitSuffix")}
            <input name="unitSuffix" maxLength={8} dir="ltr" />
          </label>
          <label>
            {t("unitDivisor")}
            <input name="unitDivisor" type="number" min={1} defaultValue={1} dir="ltr" />
          </label>
          <label>
            {t("locale")}
            <select name="locale">
              {locales.map((l) => (
                <option key={l} value={l}>
                  {localeNames[l]}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" name="requireConfirmation" /> {t("requireConfirmation")}
          </label>
          <div>
            <button className="btn" type="submit">
              {t("create")}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
