import { asAuth, schema } from "@poker/db";
import { eq, sql } from "@poker/db";
import { getDb } from "@/lib/db";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import {
  deleteAccountAction,
  saveNotificationsAction,
  saveProfileAction,
  setThemeAction,
} from "@/app/actions/account";
import { resendVerificationAction } from "@/app/actions/auth";
import { Link } from "@/i18n/navigation";
import { mailConfigured } from "@/lib/mail";
import { requireUser, withUser } from "@/lib/session";
import { THEME_COOKIE, THEMES, isTheme } from "@/lib/theme";
import type { NotifySettings } from "@/telegram/notifications";

const ERRORS = ["rateLimited", "confirmDelete", "invalid", "badCode", "linkInvalid", "INVALID"] as const;

export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; sent?: string; verified?: string }>;
}) {
  const user = await requireUser();
  const q = await searchParams;
  const t = await getTranslations("settings");
  const ta = await getTranslations("auth");
  const [me] = await withUser((tx) =>
    tx
      .select({ settings: schema.users.settings, telegramId: schema.users.telegramId })
      .from(schema.users)
      .where(eq(schema.users.id, user.id)),
  );
  // Which checks deletion asks for (only the yes/no answers, never the values).
  const [login] = await asAuth(getDb(), (tx) =>
    tx
      .select({ password: sql<boolean>`${schema.users.passwordHash} IS NOT NULL`, totp: sql<boolean>`${schema.users.totpEnabledAt} IS NOT NULL` })
      .from(schema.users)
      .where(eq(schema.users.id, user.id)),
  );
  const s = (me?.settings ?? {}) as NotifySettings;
  const theme = (await cookies()).get(THEME_COOKIE)?.value;
  const current = isTheme(theme) ? theme : "system";
  const error = ERRORS.find((e) => e === q.error);

  return (
    <>
      <h1>{t("title")}</h1>
      {error && <div className="alert">{error === "INVALID" ? t("nameRequired") : t(`errors.${error}`)}</div>}
      {q.saved && <div className="alert ok">{t("saved")}</div>}
      {q.verified && <div className="alert ok">{t("emailVerified")}</div>}

      <section className="card stack">
        <h2>{t("profile")}</h2>
        <form action={saveProfileAction} className="row">
          <label className="grow">
            {ta("displayName")}
            <input name="displayName" defaultValue={user.displayName} maxLength={80} required />
          </label>
          <button className="btn" type="submit">
            {t("save")}
          </button>
        </form>
        {user.email && (
          <p className="small">
            {ta("email")}: <span dir="ltr">{user.email}</span>{" "}
            {user.emailVerified ? <span className="muted">· {t("verified")}</span> : <strong>· {t("notVerified")}</strong>}
          </p>
        )}
        {user.email && !user.emailVerified && (
          <form action={resendVerificationAction} className="stack">
            {q.sent && <p className="small">{t("verifySent")}</p>}
            {!mailConfigured() && <p className="small muted">{t("mailOff")}</p>}
            <button className="btn small secondary" type="submit">
              {t("resend")}
            </button>
          </form>
        )}
        <p>
          <Link href="/security">{t("securityLink")}</Link>
        </p>
      </section>

      <section className="card stack">
        <h2>{t("theme")}</h2>
        <form action={setThemeAction} className="row">
          {THEMES.map((th) => (
            <label key={th} className="row" style={{ gap: 6, alignItems: "center" }}>
              <input type="radio" name="theme" value={th} defaultChecked={th === current} />
              {t(`themes.${th}`)}
            </label>
          ))}
          <button className="btn small" type="submit">
            {t("save")}
          </button>
        </form>
      </section>

      <section className="card stack">
        <h2>{t("notifications")}</h2>
        <form action={saveNotificationsAction} className="stack">
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" name="nightReminders" defaultChecked={s.nightReminders !== false} />
            {t("nightReminders")}
          </label>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" name="nightEmails" defaultChecked={s.nightEmails !== false} />
            {t("nightEmails")}
          </label>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" name="debtReminders" defaultChecked={s.debtReminders !== false} />
            {t("debtReminders")}
          </label>
          <p className="small muted">{t("notificationsNote")}</p>
          <div>
            <button className="btn small" type="submit">
              {t("save")}
            </button>
          </div>
        </form>
      </section>

      <section className="card stack">
        <h2>{t("data")}</h2>
        <p className="small muted">{t("exportNote")}</p>
        <p>
          <a className="btn small secondary" href="/api/account/export" download>
            {t("export")}
          </a>
        </p>
      </section>

      <section className="card stack">
        <h2>{t("deleteTitle")}</h2>
        <p className="small">{t("deleteNote")}</p>
        <form action={deleteAccountAction} className="stack">
          <label>
            {t("deleteConfirm")}
            <input name="confirm" autoComplete="off" required dir="ltr" placeholder="DELETE" />
          </label>
          {login?.password && (
            <label>
              {t("deletePassword")}
              <input type="password" name="password" autoComplete="current-password" required dir="ltr" />
            </label>
          )}
          {login?.totp && (
            <label>
              {t("deleteCode")}
              <input name="code" autoComplete="one-time-code" required dir="ltr" />
            </label>
          )}
          <div>
            <button className="btn danger" type="submit">
              {t("deleteButton")}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
