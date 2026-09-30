import { getTranslations } from "next-intl/server";
import { type ProviderId, providerEnabled } from "@/lib/oidc";

/** "Continue with Google / Apple". Plain links: the start route redirects to the provider. */
export async function ProviderButtons({ locale, next }: { locale: string; next?: string }) {
  const t = await getTranslations("auth");
  const shown = (["google", "apple"] as ProviderId[]).filter(providerEnabled);
  if (!shown.length) return null;
  const href = (p: ProviderId) => {
    const q = new URLSearchParams({ locale });
    if (next) q.set("next", next);
    return `/api/auth/${p}/start?${q}`;
  };
  return (
    <div className="stack" style={{ marginBlockStart: 16 }}>
      {shown.map((p) => (
        <a key={p} className="btn secondary" href={href(p)}>
          {t(p === "google" ? "withGoogle" : "withApple")}
        </a>
      ))}
    </div>
  );
}
