import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("states");
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t("loading")}</span>
      <div className="skeleton" style={{ height: 36, width: "min(320px, 70%)", marginBlockEnd: 20 }} />
      <div className="skeleton" style={{ height: 120, marginBlockEnd: 16 }} />
      <div className="skeleton" style={{ height: 120 }} />
    </div>
  );
}
