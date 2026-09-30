import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function Landing({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ deleted?: string }>;
}) {
  const { locale } = await params;
  const { deleted } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("landing");
  return (
    <>
      {deleted && <div className="alert ok">{t("deleted")}</div>}
      <section className="hero">
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
        <div className="row" style={{ marginBlockStart: 20 }}>
          <Link className="btn" href="/signup">
            {t("cta")}
          </Link>
          <Link className="btn secondary" href="/tools/sidepot">
            {t("tryTool")}
          </Link>
        </div>
      </section>
      <section className="grid" style={{ marginBlockStart: 24 }}>
        {(["f1", "f2", "f3"] as const).map((f) => (
          <div className="card" key={f}>
            <h3>{t(`${f}Title`)}</h3>
            <p className="muted" style={{ margin: 0 }}>
              {t(`${f}Body`)}
            </p>
          </div>
        ))}
      </section>
      <p className="muted small">{t("disclaimer")}</p>
    </>
  );
}
