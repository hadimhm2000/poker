import { getTranslations } from "next-intl/server";
import { signUpAction } from "@/app/actions/auth";
import { Link } from "@/i18n/navigation";

const ERRORS = ["weak", "breached", "cannotCreate", "rateLimited"] as const;

export default async function SignUp({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const t = await getTranslations("auth");
  return (
    <div className="card" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("signUpTitle")}</h1>
      {error && ERRORS.includes(error as (typeof ERRORS)[number]) && (
        <div className="alert">{t(error as (typeof ERRORS)[number])}</div>
      )}
      <form action={signUpAction} className="stack">
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
      <p className="small muted">
        {t("haveAccount")} <Link href="/signin">{t("submitSignIn")}</Link>
      </p>
    </div>
  );
}
