import "@fontsource-variable/inter";
import "@fontsource-variable/vazirmatn";
import "@fontsource-variable/noto-sans-arabic";
import "../globals.css";
import type { Metadata } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
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
  return { title: t("title"), description: t("description"), manifest: "/manifest.webmanifest" };
}

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
  const user = await currentUser();
  const theme = (await cookies()).get(THEME_COOKIE)?.value;

  return (
    <html lang={locale} dir={dir(locale)} data-theme={isTheme(theme) && theme !== "system" ? theme : undefined}>
      <body>
        <NextIntlClientProvider>
          <header className="topbar">
            <div className="shell">
              <Link href={user ? "/homes" : "/"} className="brand">
                ♠ Poker Home
              </Link>
              <nav className="nav">
                {user && !user.needsTwoFactor && <Link href="/homes">{t("homes")}</Link>}
                <Link href="/tools/sidepot">{t("sidepot")}</Link>
                <Link href="/tools/showdown">{t("showdown")}</Link>
                <Link href="/rules">{t("rules")}</Link>
                <Link href="/pricing">{t("pricing")}</Link>
                {user ? (
                  <>
                    {!user.needsTwoFactor && <Link href="/account/billing">{t("billing")}</Link>}
                    <Link href="/settings">{t("settings")}</Link>
                    {isAdmin(user) && <Link href="/admin">{t("admin")}</Link>}
                    <form action={signOutAction}>
                      <button className="linklike" type="submit">
                        {t("signOut")}
                      </button>
                    </form>
                  </>
                ) : (
                  <Link href="/signin">{t("signIn")}</Link>
                )}
                <LocaleSwitcher label={t("language")} />
              </nav>
            </div>
          </header>
          <main className="shell">{children}</main>
          <footer className="shell footer small muted">
            <Link href="/terms">{t("terms")}</Link> · <Link href="/privacy">{t("privacy")}</Link>
          </footer>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
