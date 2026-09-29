import { getTranslations, setRequestLocale } from "next-intl/server";
import { Showdown } from "@/components/Showdown";

export default async function ShowdownPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("showdown");
  return (
    <>
      <h1>{t("title")}</h1>
      <p className="muted">{t("intro")}</p>
      <Showdown />
    </>
  );
}
