import { asAuth, consumeEmailToken, markEmailVerified } from "@poker/db";
import { type NextRequest, NextResponse } from "next/server";
import { locales } from "@/i18n/routing";
import { sha256 } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { appOrigin } from "@/lib/live";

/** The link in the verification email. Works without being signed in (other device). */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const locale = locales.find((l) => l === q.get("locale")) ?? "en";
  const token = q.get("token") ?? "";
  let ok = false;
  if (token && token.length <= 100) {
    ok = await asAuth(getDb(), async (tx) => {
      const t = await consumeEmailToken(tx, sha256(token), "verify");
      if (t) await markEmailVerified(tx, t.userId);
      return !!t;
    });
  }
  return NextResponse.redirect(new URL(`/${locale}/settings?${ok ? "verified=1" : "error=linkInvalid"}`, await appOrigin()), 303);
}
