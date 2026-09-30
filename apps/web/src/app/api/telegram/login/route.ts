import { signInWithTelegram } from "@/lib/telegram-auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { verifyLoginWidget } from "@/telegram/verify";

export const dynamic = "force-dynamic";

/** Telegram Login Widget: the page posts the widget's signed fields; we check the HMAC. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const data = Object.fromEntries(
    Object.entries(body ?? {})
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => [k, String(v)]),
  );
  const user = verifyLoginWidget(data, process.env.TELEGRAM_BOT_TOKEN ?? "", 600);
  if (!user) return Response.json({ error: "INVALID" }, { status: 401 });
  if (!rateLimit(`tg-login:${user.id}`, 10, 10 * 60e3)) return Response.json({ error: "rateLimited" }, { status: 429 });
  const r = await signInWithTelegram(user);
  return Response.json({ next: r.needsTwoFactor ? "/signin/2fa" : "/homes" });
}
