import { getTranslations } from "next-intl/server";
import { forgotPasswordAction } from "@/app/actions/auth";
import { Link } from "@/i18n/navigation";

export default async function Forgot({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string }> }) {
  const { error, sent } = await searchParams;
  const t = await getTranslations("auth");
  return (
    <div className="card stack" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("forgotTitle")}</h1>
      {error === "rateLimited" && <div className="alert">{t("rateLimited")}</div>}
      {error === "linkInvalid" && <div className="alert">{t("linkInvalid")}</div>}
      {sent ? (
        <div className="alert ok">{t("forgotSent")}</div>
      ) : (
        <form action={forgotPasswordAction} className="stack">
          <p className="small muted">{t("forgotIntro")}</p>
          <label>
            {t("email")}
            <input type="email" name="email" autoComplete="email" required maxLength={254} dir="ltr" />
          </label>
          <button className="btn" type="submit">
            {t("forgotSubmit")}
          </button>
        </form>
      )}
      <p className="small">
        <Link href="/signin">{t("backToSignIn")}</Link>
      </p>
    </div>
  );
}
