import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CheckoutButton } from "@/components/Checkout";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { appOrigin } from "@/lib/live";
import { checkoutConfig, checkoutLocale, paddleHosts } from "@/lib/paddle";
import { formatPrice, pricing } from "@/lib/pricing";

// Rows of the plan's table "Plans": [feature, Free, Pro]. Values are message keys.
const ROWS = [
  ["fHomes", "one", "five"],
  ["fGames", "games3", "unlimited"],
  ["fPlayers", "unlimited", "unlimited"],
  ["fViewers", "yes", "yes"],
  ["fLedger", "yes", "yes"],
  ["fTools", "yes", "yes"],
  ["fLive", "yes", "yes"],
  ["fStats", "basic", "full"],
  ["fSeasons", "no", "yes"],
  ["fExport", "no", "yes"],
  ["fBot", "viewOnly", "botFull"],
  ["fCard", "watermark", "noWatermark"],
  ["fImport", "no", "yes"],
] as const;

export default async function Pricing({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("billing");
  const user = await currentUser();
  const signedIn = user && !user.needsTwoFactor;
  const price = pricing();
  const checkout = checkoutConfig();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const money = (c: number) => formatPrice(c, price.currency, locale);
  const saving = Math.round((1 - price.yearlyCents / (price.monthlyCents * 12)) * 100);
  const successUrl = `${await appOrigin()}/${locale}/account/billing?welcome=1`;

  const buy = (priceId: string, label: string, primary: boolean) =>
    checkout && user ? (
      <CheckoutButton
        token={checkout.token}
        env={checkout.env}
        priceId={priceId}
        userId={user.id}
        email={user.email}
        locale={checkoutLocale(locale)}
        successUrl={successUrl}
        label={label}
        primary={primary}
      />
    ) : null;

  return (
    <>
      {checkout && signedIn && user.plan === "free" && (
        <script async nonce={nonce} src={`${paddleHosts(checkout.env).script}/paddle/v2/paddle.js`} />
      )}
      <h1>{t("title")}</h1>
      <p className="muted">{t("subtitle")}</p>

      <div className="grid pricing">
        <section className="card stack">
          <h2>{t("free")}</h2>
          <p className="price">{money(0)}</p>
          {!user ? (
            <Link className="btn secondary" href="/signup">
              {t("startFree")}
            </Link>
          ) : (
            user.plan === "free" && <span className="badge">{t("currentPlan")}</span>
          )}
        </section>
        <section className="card stack pro">
          <h2>{t("pro")}</h2>
          <p className="price">
            {t("perMonth", { price: money(price.monthlyCents) })}
            <br />
            <span className="small muted">
              {t("perYear", { price: money(price.yearlyCents) })}
              {saving > 0 && <> · {t("save", { percent: new Intl.NumberFormat(locale).format(saving) })}</>}
            </span>
          </p>
          {price.trialDays && <p className="badge">{t("trial", { days: price.trialDays })}</p>}
          {!user ? (
            <Link className="btn" href={`/signup?next=${encodeURIComponent("/pricing")}`}>
              {t("signUpToBuy")}
            </Link>
          ) : user.plan === "pro" ? (
            <>
              <span className="badge">{t("currentPlan")}</span>
              <Link href="/account/billing">{t("manage")}</Link>
            </>
          ) : checkout && signedIn ? (
            <div className="row">
              {buy(checkout.monthly, t("buyMonthly"), true)}
              {buy(checkout.yearly, t("buyYearly"), false)}
            </div>
          ) : (
            <p className="small muted">{t("unavailable")}</p>
          )}
        </section>
      </div>

      <section className="card table-wrap" style={{ marginBlockStart: 16 }}>
        <table>
          <thead>
            <tr>
              <th />
              <th>{t("free")}</th>
              <th>{t("pro")}</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([feature, free, pro]) => (
              <tr key={feature}>
                <td>{t(feature)}</td>
                <td>{t(free)}</td>
                <td>{t(pro)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="small muted">{t("keepData")}</p>
      <p className="small muted">{t("startingPrices")}</p>
    </>
  );
}
