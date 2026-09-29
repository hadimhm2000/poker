import { getTranslations } from "next-intl/server";
import { signInAction } from "@/app/actions/auth";
import { Link } from "@/i18n/navigation";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const t = await getTranslations("auth");
  return (
    <div className="card" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("signInTitle")}</h1>
      {error && ["invalid", "rateLimited"].includes(error) && <div className="alert">{t(error as "invalid")}</div>}
      <form action={signInAction} className="stack">
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
      <p className="small muted">
        {t("noAccount")} <Link href="/signup">{t("submitSignUp")}</Link>
      </p>
    </div>
  );
}
