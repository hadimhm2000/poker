import { getLocale, getTranslations } from "next-intl/server";
import { joinGameAction } from "@/app/actions/live";
import { redirect } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";

/** Landing page of a game's QR code. Joining is a POST (a prefetch or preview cannot join). */
export default async function Join({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await getLocale();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return redirect({ href: "/", locale });
  const user = await currentUser();
  if (!user) return redirect({ href: `/signup?next=${encodeURIComponent(`/join/${token}`)}`, locale });
  const t = await getTranslations("game");
  return (
    <div className="card stack" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("joinTitle")}</h1>
      <p className="muted">{t("joinHint")}</p>
      <form action={joinGameAction}>
        <input type="hidden" name="token" value={token} />
        <button className="btn" type="submit">
          {t("joinButton")}
        </button>
      </form>
    </div>
  );
}
