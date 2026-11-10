import { getTranslations, setRequestLocale } from "next-intl/server";
import { FrozenDemo } from "@/components/landing/FrozenDemo";
import { LanguagesDemo } from "@/components/landing/LanguagesDemo";
import { SettleDemo } from "@/components/landing/SettleDemo";
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
    <div className="lp">
      {deleted && (
        <div className="lp-wrap">
          <div className="alert ok" role="status">
            {t("deleted")}
          </div>
        </div>
      )}

      <section className="lp-hero">
        <div className="lp-copy">
          <h1>{t("title")}</h1>
          <p className="lead">{t("subtitle")}</p>
        </div>
        <div className="lp-actions">
          <Link className="btn large" href="/signup">
            {t("cta")}
          </Link>
          <Link href="/tools/sidepot">{t("tryTool")}</Link>
        </div>
        <div className="lp-stage">
          <div className="lp-shutter">
            <SettleDemo />
          </div>
        </div>
      </section>

      <section className="lp-wrap lp-rows">
        <div className="lp-row">
          <div className="lp-say">
            <h2>{t("f1Title")}</h2>
            <p>{t("f1Body")}</p>
          </div>
          <div className="lp-frag">
            <FrozenDemo />
          </div>
        </div>
        <div className="lp-row">
          <div className="lp-say">
            <h2>{t("f3Title")}</h2>
            <p>{t("f3Body")}</p>
          </div>
          <div className="lp-frag wide">
            <LanguagesDemo />
          </div>
        </div>
      </section>

      <section className="lp-wrap lp-close">
        <p className="lp-statement">{t("disclaimer")}</p>
        <Link className="btn large" href="/signup">
          {t("cta")}
        </Link>
      </section>
    </div>
  );
}
