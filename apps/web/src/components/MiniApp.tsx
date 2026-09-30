"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface WebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
}
declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

/** Telegram Mini App entry: signs in with Telegram's signed initData, then opens the target page. */
export function MiniApp() {
  const t = useTranslations("telegram");
  const [state, setState] = useState<"loading" | "failed" | "outside">("loading");

  useEffect(() => {
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const start = () => {
      const wa = window.Telegram?.WebApp;
      if (!wa) {
        if (tries++ < 50) timer = setTimeout(start, 100);
        else setState("outside");
        return;
      }
      wa.ready();
      wa.expand();
      if (!wa.initData) return setState("outside");
      fetch("/api/telegram/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: wa.initData }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(({ locale, next }: { locale: string; next: string }) => window.location.replace(`/${locale}${next}`))
        .catch(() => setState("failed"));
    };
    start();
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="card" style={{ maxWidth: 420, marginInline: "auto" }} role="status">
      {state === "loading" ? t("miniAppLoading") : state === "failed" ? t("miniAppFailed") : t("miniAppOutside")}
    </div>
  );
}
