import { schema, upcomingNights } from "@poker/db";
import { eq } from "@poker/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { cancelNightAction, createNightAction, rsvpAction } from "@/app/actions/nights";
import { ErrorNotice } from "@/components/ErrorNotice";
import { LocalDateTime } from "@/components/LocalDateTime";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { withUser } from "@/lib/session";

const ANSWERS = ["yes", "maybe", "no"] as const;

export default async function Nights({
  params,
  searchParams,
}: {
  params: Promise<{ homeId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { homeId } = await params;
  const { error } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(homeId)) notFound();
  const locale = await getLocale();
  const t = await getTranslations("nights");

  const data = await withUser(async (tx, user) => {
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, homeId));
    if (!home) return null;
    return { home, nights: await upcomingNights(tx, homeId), userId: user.id };
  });
  if (!data) notFound();
  const { home, nights, userId } = data;
  const canWrite = home.ownerId === userId && !home.readOnly;
  const list = new Intl.ListFormat(locale);

  return (
    <>
      <p className="small">
        <Link href={`/homes/${home.id}`}>← {home.name}</Link>
      </p>
      <h1>{t("title")}</h1>
      <ErrorNotice code={error} />

      {nights.length === 0 && <p className="muted">{t("none")}</p>}
      {nights.map((n) => {
        const mine = n.answers.find((a) => a.userId === userId)?.answer;
        return (
          <section key={n.id} className="card stack">
            <h2>{formatDate(n.startsAt, locale, true)}</h2>
            {n.place && <p>{t("placeLine", { place: n.place })}</p>}
            {n.note && <p className="muted">{n.note}</p>}
            <ul className="plain">
              {ANSWERS.map((a) => {
                const names = n.answers.filter((x) => x.answer === a).map((x) => x.name ?? "?");
                return (
                  <li key={a}>
                    {t(`answer_${a}`)}: {names.length ? list.format(names) : "—"}
                  </li>
                );
              })}
            </ul>
            <form action={rsvpAction} className="row">
              <input type="hidden" name="homeId" value={home.id} />
              <input type="hidden" name="nightId" value={n.id} />
              {ANSWERS.map((a) => (
                <button
                  key={a}
                  className={`btn small ${mine === a ? "" : "secondary"}`}
                  type="submit"
                  name="answer"
                  value={a}
                  aria-pressed={mine === a}
                >
                  {t(`rsvp_${a}`)}
                </button>
              ))}
            </form>
            {canWrite && (
              <form action={cancelNightAction}>
                <input type="hidden" name="homeId" value={home.id} />
                <input type="hidden" name="nightId" value={n.id} />
                <button className="linklike small" type="submit">
                  {t("cancel")}
                </button>
              </form>
            )}
          </section>
        );
      })}

      {canWrite && (
        <section className="card">
          <h2>{t("plan")}</h2>
          <form action={createNightAction} className="stack">
            <input type="hidden" name="homeId" value={home.id} />
            <LocalDateTime name="startsAt" label={t("when")} />
            <label>
              {t("place")}
              <input name="place" maxLength={120} />
            </label>
            <label>
              {t("note")}
              <textarea name="note" maxLength={500} rows={2} />
            </label>
            {home.telegramChatId && <p className="small muted">{t("postedToGroup")}</p>}
            <button className="btn" type="submit">
              {t("create")}
            </button>
          </form>
        </section>
      )}
    </>
  );
}
