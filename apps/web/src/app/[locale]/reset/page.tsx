import { getTranslations } from "next-intl/server";
import { resetPasswordAction } from "@/app/actions/auth";

const ERRORS = ["rateLimited", "weak", "breached"] as const;

export default async function Reset({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token = "", error } = await searchParams;
  const t = await getTranslations("auth");
  const e = ERRORS.find((x) => x === error);
  return (
    <div className="card stack" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("resetTitle")}</h1>
      {e && <div className="alert">{t(e)}</div>}
      <form action={resetPasswordAction} className="stack">
        <input type="hidden" name="token" value={token.slice(0, 100)} />
        <label>
          {t("newPassword")}
          <input type="password" name="password" autoComplete="new-password" required minLength={10} maxLength={200} dir="ltr" />
          <span className="small muted">{t("passwordHint")}</span>
        </label>
        <button className="btn" type="submit">
          {t("resetSubmit")}
        </button>
      </form>
    </div>
  );
}
