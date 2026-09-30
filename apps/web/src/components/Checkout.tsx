"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

interface PaddleJs {
  Environment: { set: (env: string) => void };
  Initialize: (opts: { token: string }) => void;
  Checkout: {
    open: (opts: {
      items: { priceId: string; quantity: number }[];
      customData: Record<string, string>;
      customer?: { email: string };
      settings: Record<string, unknown>;
    }) => void;
  };
}
declare global {
  interface Window {
    Paddle?: PaddleJs;
    __paddleReady?: boolean;
  }
}

/**
 * Opens Paddle's overlay checkout. The user id goes along as custom_data so the signed
 * webhook can map the subscription to this account; discount codes are entered in the
 * checkout itself. Paddle.js is loaded by the page with the CSP nonce.
 */
export function CheckoutButton({
  token,
  env,
  priceId,
  userId,
  email,
  locale,
  successUrl,
  label,
  primary,
}: {
  token: string;
  env: "sandbox" | "production";
  priceId: string;
  userId: string;
  email: string | null;
  locale: string;
  successUrl: string;
  label: string;
  primary?: boolean;
}) {
  const t = useTranslations("billing");
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  const open = () => {
    setState("loading");
    let tries = 0;
    const tryOpen = () => {
      const paddle = window.Paddle;
      if (!paddle) {
        if (tries++ < 50) return setTimeout(tryOpen, 100);
        return setState("failed");
      }
      try {
        if (!window.__paddleReady) {
          if (env === "sandbox") paddle.Environment.set("sandbox");
          paddle.Initialize({ token });
          window.__paddleReady = true;
        }
        paddle.Checkout.open({
          items: [{ priceId, quantity: 1 }],
          customData: { user_id: userId },
          ...(email ? { customer: { email } } : {}),
          settings: {
            displayMode: "overlay",
            locale,
            showAddDiscounts: true,
            allowDiscountRemoval: true,
            successUrl,
          },
        });
        setState("idle");
      } catch {
        setState("failed");
      }
    };
    tryOpen();
  };

  return (
    <div className="stack">
      <button className={primary ? "btn" : "btn secondary"} type="button" onClick={open} disabled={state === "loading"}>
        {state === "loading" ? t("opening") : label}
      </button>
      {state === "failed" && (
        <p className="small alert" role="alert">
          {t("checkoutFailed")}
        </p>
      )}
    </div>
  );
}
