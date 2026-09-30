import { asAuth, schema } from "@poker/db";
import { eq } from "@poker/db";
import { getLocale, getTranslations } from "next-intl/server";
import QRCode from "qrcode";
import { enableTwoFactorAction, signOutAllAction, startTwoFactorAction } from "@/app/actions/auth";
import { connectTelegramAction, disconnectTelegramAction } from "@/app/actions/telegram";
import { telegramConfigured } from "@/telegram/instance";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireUser, withUser } from "@/lib/session";
import { pendingTotpSecret, totpFor } from "@/lib/totp";

export default async function Security({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const locale = await getLocale();
  const { error } = await searchParams;
  const t = await getTranslations("auth");
  const tt = await getTranslations("telegram");
  const [row] = await asAuth(getDb(), (tx) =>
    tx
      .select({ on: schema.users.totpEnabledAt, telegramId: schema.users.telegramId })
      .from(schema.users)
      .where(eq(schema.users.id, user.id)),
  );
  const sessions = await withUser((tx) =>
    tx
      .select({ id: schema.sessions.id, ua: schema.sessions.userAgent, lastSeen: schema.sessions.lastSeenAt })
      .from(schema.sessions),
  );
  const pending = row?.on ? null : await pendingTotpSecret();
  const qr = pending ? await QRCode.toDataURL(totpFor(pending, user.email ?? "").toString(), { margin: 1, width: 200 }) : null;

  return (
    <>
      <h1>{t("securityTitle")}</h1>
      <section className="card stack">
        <h2>{t("twoFactorTitle")}</h2>
        {error && ["badCode", "rateLimited"].includes(error) && <div className="alert">{t(error as "badCode")}</div>}
        {row?.on ? (
          <p>{t("twoFactorOn")}</p>
        ) : pending && qr ? (
          <>
            <p>{t("scan")}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="" width={200} height={200} />
            <p className="mono">{t("secret", { secret: pending })}</p>
            <form action={enableTwoFactorAction} className="row">
              <label style={{ flex: 1 }}>
                {t("code")}
                <input name="code" inputMode="numeric" autoComplete="one-time-code" required dir="ltr" />
              </label>
              <button className="btn" type="submit">
                {t("verify")}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="muted">{t("twoFactorOff")}</p>
            <form action={startTwoFactorAction}>
              <button className="btn" type="submit">
                {t("enable2fa")}
              </button>
            </form>
          </>
        )}
      </section>
      {telegramConfigured() && (
        <section className="card stack">
          <h2>{tt("accountTitle")}</h2>
          {row?.telegramId ? (
            <>
              <p>{tt("accountLinked")}</p>
              <form action={disconnectTelegramAction}>
                <button className="btn secondary" type="submit">
                  {tt("disconnect")}
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="muted">{tt("accountNotLinked")}</p>
              <form action={connectTelegramAction}>
                <button className="btn" type="submit">
                  {tt("connect")}
                </button>
              </form>
            </>
          )}
        </section>
      )}
      <section className="card">
        <h2>{t("sessions")}</h2>
        <ul>
          {sessions.map((s) => (
            <li key={s.id} className="small">
              {s.ua ?? "—"} · <span className="muted">{formatDate(s.lastSeen, locale, true)}</span>
            </li>
          ))}
        </ul>
        <form action={signOutAllAction}>
          <button className="btn secondary" type="submit">
            {t("signOutAll")}
          </button>
        </form>
      </section>
    </>
  );
}
