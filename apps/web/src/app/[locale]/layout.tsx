import "@fontsource-variable/inter";
import "@fontsource-variable/vazirmatn";
import "@fontsource-variable/noto-sans-arabic";
import "../globals.css";
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { Logo } from "@/components/Logo";
import { NavLink } from "@/components/NavLink";
import { dir, routing } from "@/i18n/routing";
import { currentUser } from "@/lib/auth";
import { signOutAction } from "../actions/auth";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { cookies } from "next/headers";
import { THEME_COOKIE, isTheme } from "@/lib/theme";
import { isAdmin } from "@/lib/admin";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: { default: t("title"), template: `%s · ${t("title")}` },
    description: t("description"),
    manifest: "/manifest.webmanifest",
    applicationName: "Poker Home",
    icons: { apple: "/apple-touch-icon.png" },
    openGraph: { title: t("title"), description: t("description"), type: "website", siteName: "Poker Home" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f1" },
    { media: "(prefers-color-scheme: dark)", color: "#121311" },
  ],
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("nav");
  const ts = await getTranslations("states");
  const user = await currentUser();
  const theme = (await cookies()).get(THEME_COOKIE)?.value;

  return (
    <html lang={locale} dir={dir(locale)} data-theme={isTheme(theme) && theme !== "system" ? theme : undefined}>
      <body>
        <NextIntlClientProvider>
          <a className="skip-link" href="#main">
            {ts("skipToContent")}
          </a>
          <header className="topbar">
            <div className="shell">
              <Link href={user ? "/homes" : "/"} className="brand">
                <Logo />
                Poker Home
              </Link>
              <nav className="nav" aria-label="Poker Home">
                {user && !user.needsTwoFactor && <NavLink href="/homes">{t("homes")}</NavLink>}
                <NavLink href="/tools/sidepot">{t("sidepot")}</NavLink>
                <NavLink href="/tools/showdown">{t("showdown")}</NavLink>
                <NavLink href="/rules">{t("rules")}</NavLink>
                <NavLink href="/pricing">{t("pricing")}</NavLink>
                {user ? (
                  <>
                    {!user.needsTwoFactor && <NavLink href="/account/billing">{t("billing")}</NavLink>}
                    <NavLink href="/settings">{t("settings")}</NavLink>
                    {isAdmin(user) && <NavLink href="/admin">{t("admin")}</NavLink>}
                    <form action={signOutAction}>
                      <button className="linklike" type="submit">
                        {t("signOut")}
                      </button>
                    </form>
                  </>
                ) : (
                  <NavLink href="/signin">{t("signIn")}</NavLink>
                )}
                <LocaleSwitcher label={t("language")} />
              </nav>
            </div>
          </header>
          <main id="main" className="shell" tabIndex={-1}>
            {children}
          </main>
          <footer className="shell footer small muted">
            <Link href="/terms">{t("terms")}</Link> · <Link href="/privacy">{t("privacy")}</Link>
          </footer>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
