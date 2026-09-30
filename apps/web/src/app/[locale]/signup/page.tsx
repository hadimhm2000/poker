import { getLocale, getTranslations } from "next-intl/server";
import { signUpAction } from "@/app/actions/auth";
import { ProviderButtons } from "@/components/ProviderButtons";
import { Link } from "@/i18n/navigation";

const ERRORS = ["weak", "breached", "cannotCreate", "rateLimited"] as const;

export default async function SignUp({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const t = await getTranslations("auth");
  const locale = await getLocale();
  return (
    <div className="card" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("signUpTitle")}</h1>
      {error && ERRORS.includes(error as (typeof ERRORS)[number]) && (
        <div className="alert">{t(error as (typeof ERRORS)[number])}</div>
      )}
      <form action={signUpAction} className="stack">
        {next && <input type="hidden" name="next" value={next} />}
        <label>
          {t("displayName")}
          <input name="displayName" autoComplete="nickname" required maxLength={80} />
        </label>
        <label>
          {t("email")}
          <input type="email" name="email" autoComplete="email" required maxLength={254} dir="ltr" />
        </label>
        <label>
          {t("password")}
          <input type="password" name="password" autoComplete="new-password" required minLength={10} maxLength={200} dir="ltr" />
          <span className="small">{t("passwordHint")}</span>
        </label>
        <button className="btn" type="submit">
          {t("submitSignUp")}
        </button>
      </form>
      <ProviderButtons locale={locale} next={next} />
      <p className="small muted">
        {t("haveAccount")} <Link href={next ? `/signin?next=${encodeURIComponent(next)}` : "/signin"}>{t("submitSignIn")}</Link>
      </p>
    </div>
  );
}
