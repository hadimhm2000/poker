import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/Logo";
import { Link } from "@/i18n/navigation";

export default async function NotFound() {
  const t = await getTranslations("states");
  return (
    <div className="state-page">
      <Logo />
      <h1>{t("notFoundTitle")}</h1>
      <p>{t("notFoundBody")}</p>
      <div className="row">
        <Link className="btn" href="/">
          {t("backHome")}
        </Link>
      </div>
    </div>
  );
}
