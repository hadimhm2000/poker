import { getLocale, getTranslations } from "next-intl/server";
import { acceptInviteAction } from "@/app/actions/homes";
import { redirect } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await currentUser();
  if (!user) return redirect({ href: "/signup", locale: await getLocale() });
  const t = await getTranslations("homes");
  return (
    <div className="card" style={{ maxWidth: 420, marginInline: "auto" }}>
      <h1>{t("invite")}</h1>
      <form action={acceptInviteAction}>
        <input type="hidden" name="token" value={token} />
        <button className="btn" type="submit">
          {t("join")}
        </button>
      </form>
    </div>
  );
}
