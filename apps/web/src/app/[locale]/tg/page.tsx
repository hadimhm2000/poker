import { headers } from "next/headers";
import { MiniApp } from "@/components/MiniApp";

/** Opened by Telegram as the Mini App (menu button, /start button, t.me/<bot>/<app> links). */
export default async function TelegramMiniApp() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      <script src="https://telegram.org/js/telegram-web-app.js" nonce={nonce} async />
      <MiniApp />
    </>
  );
}
