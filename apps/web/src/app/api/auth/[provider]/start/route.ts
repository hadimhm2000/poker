import { type NextRequest, NextResponse } from "next/server";
import { locales } from "@/i18n/routing";
import { currentUser } from "@/lib/auth";
import { encryptField } from "@/lib/crypto";
import { appOrigin } from "@/lib/live";
import { safeNext } from "@/lib/next-path";
import { authorizationUrl, isProvider, newFlow, providerEnabled, usesFormPost } from "@/lib/oidc";

const flowCookie = (p: string) => `oidc_${p}`;

/** Start "Continue with Google / Apple" (?intent=link from the security page). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isProvider(provider) || !providerEnabled(provider)) return new NextResponse("Not found", { status: 404 });
  const q = request.nextUrl.searchParams;
  const locale = locales.find((l) => l === q.get("locale")) ?? "en";
  const intent = q.get("intent") === "link" ? "link" : "signin";
  let userId: string | null = null;
  if (intent === "link") {
    const user = await currentUser();
    if (!user || user.needsTwoFactor) return NextResponse.redirect(new URL(`/${locale}/signin`, request.url));
    userId = user.id;
  }
  const flow = newFlow({ intent, locale, next: safeNext(q.get("next")), userId });
  const res = NextResponse.redirect(authorizationUrl(provider, flow, await appOrigin()));
  const prod = process.env.NODE_ENV === "production";
  res.cookies.set(flowCookie(provider), encryptField(JSON.stringify(flow)).toString("base64url"), {
    httpOnly: true,
    secure: prod,
    // Apple comes back with a cross-site form POST, which only carries SameSite=None cookies.
    sameSite: usesFormPost(provider) && prod ? "none" : "lax",
    path: `/api/auth/${provider}`,
    maxAge: 600,
  });
  return res;
}
