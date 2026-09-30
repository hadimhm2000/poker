import { signInWithTelegram } from "@/lib/telegram-auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { verifyInitData } from "@/telegram/verify";

export const dynamic = "force-dynamic";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const START = new RegExp(`^(game|home)_(${UUID})$`);

/** Where a Mini App start parameter (t.me/<bot>/<app>?startapp=...) should land. */
function target(startParam: string | null): string {
  if (startParam === "sidepot") return "/tools/sidepot";
  const m = startParam?.match(START);
  if (m) return m[1] === "game" ? `/games/${m[2]}` : `/homes/${m[2]}`;
  return "/homes";
}

/** Mini App sign-in: the page posts Telegram's initData; we check its HMAC and start a session. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { initData?: unknown } | null;
  const initData = typeof body?.initData === "string" ? body.initData : "";
  const v = verifyInitData(initData, process.env.TELEGRAM_BOT_TOKEN ?? "", 3600);
  if (!v) return Response.json({ error: "INVALID" }, { status: 401 });
  if (!rateLimit(`tg-session:${v.user.id}`, 20, 10 * 60e3)) return Response.json({ error: "rateLimited" }, { status: 429 });
  const r = await signInWithTelegram(v.user, { embedded: true });
  return Response.json({
    locale: r.locale,
    next: r.needsTwoFactor ? "/signin/2fa" : target(v.startParam),
  });
}
