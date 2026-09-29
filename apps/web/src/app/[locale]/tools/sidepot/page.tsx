import { getTranslations, setRequestLocale } from "next-intl/server";
import { SidePotCalculator } from "@/components/SidePotCalculator";

export default async function SidePotPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("sidepot");
  return (
    <>
      <h1>{t("title")}</h1>
      <p className="muted">{t("intro")}</p>
      <SidePotCalculator />
    </>
  );
}
