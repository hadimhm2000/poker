import { getLocale, getTranslations } from "next-intl/server";
import { signInAction } from "@/app/actions/auth";
import { ProviderButtons } from "@/components/ProviderButtons";
import { TelegramLogin } from "@/components/TelegramLogin";
import { Link } from "@/i18n/navigation";
import { botUsername, telegramConfigured } from "@/telegram/instance";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string; next?: string; reset?: string }> }) {
  const { error, next, reset } = await searchParams;
  const t = await getTranslations("auth");
  const locale = await getLocale();
  return (
    <div className="card" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("signInTitle")}</h1>
      {error && ["invalid", "rateLimited", "oauthFailed"].includes(error) && <div className="alert">{t(error as "invalid")}</div>}
      {error === "EMAIL_IN_USE" && <div className="alert">{t("emailInUse")}</div>}
      {reset && <div className="alert ok">{t("resetDone")}</div>}
      <form action={signInAction} className="stack">
        {next && <input type="hidden" name="next" value={next} />}
        <label>
          {t("email")}
          <input type="email" name="email" autoComplete="email" required maxLength={254} dir="ltr" />
        </label>
        <label>
          {t("password")}
          <input type="password" name="password" autoComplete="current-password" required maxLength={200} dir="ltr" />
        </label>
        <button className="btn" type="submit">
          {t("submitSignIn")}
        </button>
        <Link className="small" href="/forgot">
          {t("forgotLink")}
        </Link>
      </form>
      <ProviderButtons locale={locale} next={next} />
      {telegramConfigured() && (
        <div className="stack" style={{ marginBlockStart: 16 }}>
          <p className="small muted">{t("orTelegram")}</p>
          <TelegramLogin bot={botUsername()} locale={locale} />
        </div>
      )}
      <p className="small muted">
        {t("noAccount")} <Link href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}>{t("submitSignUp")}</Link>
      </p>
    </div>
  );
}
