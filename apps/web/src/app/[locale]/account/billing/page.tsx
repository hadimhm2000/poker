import { proEndsAt } from "@poker/domain";
import { and, desc, eq, schema, sql } from "@poker/db";
import { getLocale, getTranslations } from "next-intl/server";
import { openPortalAction } from "@/app/actions/billing";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { portalConfigured } from "@/lib/paddle";
import { withUser } from "@/lib/session";

export default async function Billing({ searchParams }: { searchParams: Promise<{ error?: string; welcome?: string }> }) {
  const { error, welcome } = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations("billing");
  const data = await withUser(async (tx, user) => {
    // Read the plan fresh (the session copy may predate the webhook).
    const [u] = await tx.select({ plan: schema.users.plan }).from(schema.users).where(eq(schema.users.id, user.id));
    const [sub] = await tx.select().from(schema.subscriptions).orderBy(desc(schema.subscriptions.updatedAt)).limit(1);
    const [ro] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.homes)
      .where(and(eq(schema.homes.ownerId, user.id), eq(schema.homes.readOnly, true), sql`${schema.homes.deletedAt} IS NULL`));
    return { plan: u?.plan ?? "free", sub, readOnlyHomes: ro?.n ?? 0 };
  });
  const { plan, sub, readOnlyHomes } = data;
  const endsAt = sub ? proEndsAt(sub) : null;
  const portal = portalConfigured() && !!sub?.customerRef;

  return (
    <>
      <h1>{t("accountTitle")}</h1>
      {error === "portal" ? (
        <div className="alert" role="alert">
          {t("portalFailed")}
        </div>
      ) : (
        <ErrorNotice code={error} />
      )}
      {welcome && plan === "free" && <div className="alert ok">{t("processing")}</div>}

      <section className="card stack">
        <h2>
          {t("planLabel")}: {plan === "pro" ? t("pro") : t("free")}
        </h2>
        {sub && (
          <dl className="facts">
            <dt>{t("statusLabel")}</dt>
            <dd>{t(`status_${sub.status}`)}</dd>
            {sub.billingInterval && (sub.billingInterval === "month" || sub.billingInterval === "year") && (
              <>
                <dt>{t("intervalLabel")}</dt>
                <dd>{t(`interval_${sub.billingInterval}`)}</dd>
              </>
            )}
            {endsAt ? (
              <>
                <dt>{t("endsLabel")}</dt>
                <dd>{formatDate(endsAt, locale)}</dd>
              </>
            ) : (
              sub.currentPeriodEnd &&
              sub.status !== "paused" && (
                <>
                  <dt>{t("renewsLabel")}</dt>
                  <dd>{formatDate(sub.currentPeriodEnd, locale)}</dd>
                </>
              )
            )}
          </dl>
        )}
        {sub?.status === "past_due" && (
          <div className="alert">
            {t("pastDue")}
            {portal && (
              <form action={openPortalAction} style={{ marginBlockStart: 8 }}>
                <input type="hidden" name="target" value="payment" />
                <button className="btn small" type="submit">
                  {t("updatePayment")}
                </button>
              </form>
            )}
          </div>
        )}
        {readOnlyHomes > 0 && plan === "free" && <p className="muted">{t("readOnlyHomes", { count: readOnlyHomes })}</p>}

        {portal && (
          <div className="row">
            <form action={openPortalAction}>
              <input type="hidden" name="target" value="overview" />
              <button className="btn secondary" type="submit">
                {t("invoices")}
              </button>
            </form>
            {sub.status !== "canceled" && !sub.cancelAt && (
              <form action={openPortalAction}>
                <input type="hidden" name="target" value="cancel" />
                <button className="btn secondary" type="submit">
                  {t("cancel")}
                </button>
              </form>
            )}
          </div>
        )}
        {plan === "free" && (
          <p>
            <Link className="btn" href="/pricing">
              {t("seePlans")}
            </Link>
          </p>
        )}
      </section>
      <p className="small muted">{t("keepData")}</p>
    </>
  );
}
