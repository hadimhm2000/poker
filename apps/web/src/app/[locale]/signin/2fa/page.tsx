import { getLocale, getTranslations } from "next-intl/server";
import { verifyTwoFactorAction } from "@/app/actions/auth";
import { redirect } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";

export default async function TwoFactor({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await currentUser();
  if (!user) return redirect({ href: "/signin", locale: await getLocale() });
  const { error } = await searchParams;
  const t = await getTranslations("auth");
  return (
    <div className="card" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("twoFactorTitle")}</h1>
      <p className="muted">{t("twoFactorPrompt")}</p>
      {error && ["badCode", "rateLimited"].includes(error) && <div className="alert">{t(error as "badCode")}</div>}
      <form action={verifyTwoFactorAction} className="stack">
        <label>
          {t("code")}
          <input name="code" autoComplete="one-time-code" maxLength={20} required dir="ltr" />
        </label>
        <span className="small muted">{t("recoveryHint")}</span>
        <button className="btn" type="submit">
          {t("verify")}
        </button>
      </form>
    </div>
  );
}
