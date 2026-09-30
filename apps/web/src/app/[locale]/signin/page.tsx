import { getLocale, getTranslations } from "next-intl/server";
import { signInAction } from "@/app/actions/auth";
import { TelegramLogin } from "@/components/TelegramLogin";
import { Link } from "@/i18n/navigation";
import { botUsername, telegramConfigured } from "@/telegram/instance";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const t = await getTranslations("auth");
  const locale = await getLocale();
  return (
    <div className="card" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("signInTitle")}</h1>
      {error && ["invalid", "rateLimited"].includes(error) && <div className="alert">{t(error as "invalid")}</div>}
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
      </form>
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
