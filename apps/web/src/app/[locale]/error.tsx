"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Logo } from "@/components/Logo";
import { Link } from "@/i18n/navigation";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("states");
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="state-page" role="alert">
      <Logo />
      <h1>{t("errorTitle")}</h1>
      <p>{t("errorBody")}</p>
      <div className="row">
        <button className="btn" type="button" onClick={reset}>
          {t("retry")}
        </button>
        <Link className="btn secondary" href="/">
          {t("backHome")}
        </Link>
      </div>
    </div>
  );
}
