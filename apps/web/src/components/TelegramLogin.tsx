import { headers } from "next/headers";

/**
 * Telegram Login Widget. The widget hands the signed fields to a callback on this page, which
 * POSTs them to /api/telegram/login (same-origin check, then HMAC check on the server). A POST
 * instead of the widget's redirect keeps other sites from signing a visitor into their account.
 */
export async function TelegramLogin({ bot, locale }: { bot: string; locale: string }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const callback = `window.onTelegramAuth = function (user) {
  fetch("/api/telegram/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(user) })
    .then(function (r) { return r.json(); })
    .then(function (r) { window.location.assign("/${locale}" + (r.next || "/signin?error=invalid")); });
};`;
  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: callback }} />
      <script
        async
        nonce={nonce}
        src="https://telegram.org/js/telegram-widget.js?22"
        data-telegram-login={bot}
        data-size="large"
        data-lang={locale}
        data-onauth="onTelegramAuth(user)"
        data-request-access="write"
      />
    </>
  );
}
