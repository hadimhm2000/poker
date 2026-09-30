import { asUser, eq, schema } from "@poker/db";
import { CATEGORY_COMBINATIONS, HAND_EXAMPLES, SITUATIONS, searchRules } from "@poker/domain";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PotLimitCalc } from "@/components/PotLimitCalc";
import { CardRow, RuleExample } from "@/components/RuleExample";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const HOLDEM = ["cards", "blinds", "rounds", "minRaise", "showdown", "headsUp"] as const;
const OMAHA = ["cards", "twoThree", "potLimit"] as const;

/** The question of the day changes at midnight UTC. */
function dayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/** House rules of a home the viewer belongs to (?home=…), or null. */
async function houseRules(homeId: string | undefined) {
  if (!homeId || !/^[0-9a-f-]{36}$/i.test(homeId)) return null;
  const user = await currentUser();
  if (!user || user.needsTwoFactor) return null;
  const [h] = await asUser(getDb(), user.id, (tx) =>
    tx.select({ id: schema.homes.id, name: schema.homes.name, rules: schema.homes.houseRules }).from(schema.homes).where(eq(schema.homes.id, homeId)),
  );
  return h ?? null;
}

export default async function RulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; home?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { q = "", home: homeId } = await searchParams;
  const t = await getTranslations("rules");
  const th = await getTranslations("hand");
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);

  const situationText = (id: string) =>
    ["title", "ruling", "example"]
      .map((k) => `s.${id}.${k}`)
      .filter((k) => t.has(k))
      .map((k) => t(k))
      .join(" ");
  const query = q.trim().slice(0, 80);
  const found = query ? new Set(searchRules(query, situationText)) : null;
  const shown = SITUATIONS.filter((s) => !found || found.has(s.id));

  const withExample = SITUATIONS.filter((s) => s.example);
  const daily = withExample[dayNumber() % withExample.length]!;
  const home = await houseRules(homeId);

  return (
    <>
      <h1>{t("title")}</h1>
      <p className="muted">{t("intro")}</p>
      <p className="small muted">
        {t("source")} {locale !== "en" && t("reviewNote")}
      </p>

      {home && (
        <section className="card stack" id="house">
          <h2>{t("houseLabel", { home: home.name })}</h2>
          {home.rules ? <p className="house-rules">{home.rules}</p> : <p className="muted">{t("houseNone")}</p>}
        </section>
      )}

      <section className="card">
        <h2>{t("contents")}</h2>
        <ul className="rules-toc">
          <li>
            <a href="#hands">{t("handsTitle")}</a>
          </li>
          <li>
            <a href="#holdem">{t("holdemTitle")}</a>
          </li>
          <li>
            <a href="#omaha">{t("omahaTitle")}</a>
          </li>
          <li>
            <a href="#situations">{t("situationsTitle")}</a>
          </li>
          <li>
            <a href="#daily">{t("dailyTitle")}</a>
          </li>
        </ul>
      </section>

      <section className="card stack" id="hands">
        <h2>{t("handsTitle")}</h2>
        <p className="small muted">{t("handsIntro")}</p>
        <ol className="stack" style={{ paddingInlineStart: 20 }}>
          {HAND_EXAMPLES.map((h) => (
            <li key={h.key}>
              <strong>{th(h.key)}</strong>
              <div className="row" style={{ alignItems: "center", marginBlock: 4 }}>
                <CardRow cards={h.cards} />
              </div>
              <div className="small">{t(`hands.${h.key}`)}</div>
              <div className="small muted">{t("combos", { count: num(CATEGORY_COMBINATIONS[h.key]) })}</div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card stack" id="holdem">
        <h2>{t("holdemTitle")}</h2>
        {HOLDEM.map((k) => (
          <p key={k}>{t(`holdem.${k}`)}</p>
        ))}
      </section>

      <section className="card stack" id="omaha">
        <h2>{t("omahaTitle")}</h2>
        {OMAHA.map((k) => (
          <p key={k}>{t(`omaha.${k}`)}</p>
        ))}
        <h3>{t("potCalcTitle")}</h3>
        <PotLimitCalc />
      </section>

      <section className="card stack" id="situations">
        <h2>{t("situationsTitle")}</h2>
        <p className="small muted">{t("situationsIntro")}</p>
        <form className="row" action="#situations" role="search">
          <label className="grow">
            <span className="sr-only">{t("search")}</span>
            <input name="q" defaultValue={query} placeholder={t("searchPlaceholder")} aria-label={t("search")} />
          </label>
          {homeId && <input type="hidden" name="home" value={homeId} />}
          <button className="btn small" type="submit">
            {t("searchButton")}
          </button>
          {query && (
            <Link className="btn small secondary" href={homeId ? `/rules?home=${homeId}` : "/rules"}>
              {t("clearSearch")}
            </Link>
          )}
        </form>
        {query && <p className="small muted">{t("searchResults", { count: shown.length })}</p>}
        {shown.map((s) => (
          <article key={s.id} id={`s-${s.id}`} className="stack" style={{ borderBlockStart: "1px solid var(--border)", paddingBlockStart: 12 }}>
            <h3>{t(`s.${s.id}.title`)}</h3>
            <p>
              <strong>{t("ruling")}:</strong> {t(`s.${s.id}.ruling`)}
            </p>
            {t.has(`s.${s.id}.example`) && (
              <p className="small">
                <strong>{t("example")}:</strong> {t(`s.${s.id}.example`)}
              </p>
            )}
            {s.example && <RuleExample example={s.example} />}
            {s.id === "sidePot" && (
              <p>
                <Link href="/tools/sidepot">{t("openSidePot")}</Link>
              </p>
            )}
          </article>
        ))}
      </section>

      <section className="card stack" id="daily">
        <h2>{t("dailyTitle")}</h2>
        <p>
          <strong>{t(`s.${daily.id}.title`)}.</strong> {t("dailyAsk")}
        </p>
        <RuleExample example={daily.example!} reveal={false} />
        <details>
          <summary>{t("dailyReveal")}</summary>
          <div className="stack" style={{ marginBlockStart: 8 }}>
            <RuleExample example={daily.example!} />
            <p className="small">{t(`s.${daily.id}.ruling`)}</p>
          </div>
        </details>
      </section>

      <section className="card stack">
        <h2>{t("whoWinsTitle")}</h2>
        <p className="small muted">{t("whoWinsBody")}</p>
        <p>
          <Link className="btn small secondary" href="/tools/showdown">
            {t("openWhoWins")}
          </Link>
        </p>
      </section>
    </>
  );
}
