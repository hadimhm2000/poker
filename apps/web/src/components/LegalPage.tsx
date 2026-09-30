import { getTranslations } from "next-intl/server";
import { LEGAL_UPDATED, type LegalDoc, legalText } from "@/content/legal";
import { formatDate } from "@/lib/format";

export async function LegalPage({ doc, locale }: { doc: LegalDoc; locale: string }) {
  const t = await getTranslations("legal");
  const { sections, translated } = legalText(doc, locale);
  return (
    <article className="card stack legal" style={{ maxWidth: 760, marginInline: "auto" }}>
      <h1>{t(doc === "terms" ? "termsTitle" : "privacyTitle")}</h1>
      <div className="alert">{t("draftNote")}</div>
      {!translated && <p className="small muted">{t("untranslated")}</p>}
      <p className="small muted">{t("updated", { date: formatDate(new Date(`${LEGAL_UPDATED}T12:00:00Z`), locale) })}</p>
      <div className="stack" lang={translated ? locale : "en"} dir={translated ? undefined : "ltr"}>
        {sections.map((s) => (
          <section key={s.title}>
            <h2>{s.title}</h2>
            {s.body.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </section>
        ))}
      </div>
    </article>
  );
}
