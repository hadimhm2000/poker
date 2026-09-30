import { DomainError, asAuth, linkIdentity, oidcSignIn, schema } from "@poker/db";
import { eq } from "@poker/db";
import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createSession, currentUser, destroySession } from "@/lib/auth";
import { decryptField } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { appOrigin } from "@/lib/live";
import { type FlowState, exchangeCode, isProvider, providerEnabled, verifyIdToken } from "@/lib/oidc";
import { errorCode } from "@/lib/session";

const cookieName = (p: string) => `oidc_${p}`;

function readFlow(raw: string | undefined): FlowState | null {
  if (!raw) return null;
  try {
    return JSON.parse(decryptField(Buffer.from(raw, "base64url"))) as FlowState;
  } catch {
    return null;
  }
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function handle(request: NextRequest, provider: string, params: URLSearchParams) {
  if (!isProvider(provider) || !providerEnabled(provider)) return new NextResponse("Not found", { status: 404 });
  const origin = await appOrigin();
  const flow = readFlow(request.cookies.get(cookieName(provider))?.value);
  const locale = flow?.locale ?? "en";
  const go = (path: string) => {
    // 303: after Apple's POST the browser must follow with a GET.
    const res = NextResponse.redirect(new URL(`/${locale}${path}`, origin), 303);
    res.cookies.delete({ name: cookieName(provider), path: `/api/auth/${provider}` });
    return res;
  };
  const failTo = flow?.intent === "link" ? "/security" : "/signin";
  const state = params.get("state") ?? "";
  const code = params.get("code");
  if (!flow || !code || !same(state, flow.state)) return go(`${failTo}?error=oauthFailed`);

  let identity;
  try {
    const idToken = await exchangeCode(provider, code, flow, origin);
    identity = await verifyIdToken(provider, idToken, flow.nonce);
  } catch (e) {
    console.error("oidc callback failed", (e as Error).message);
    return go(`${failTo}?error=oauthFailed`);
  }
  // Apple sends the name only on the first sign-in, outside the token.
  if (!identity.name && params.get("user")) {
    try {
      const n = (JSON.parse(params.get("user")!) as { name?: { firstName?: string; lastName?: string } }).name;
      identity.name = [n?.firstName, n?.lastName].filter(Boolean).join(" ") || null;
    } catch {}
  }
  const claims = { provider, ...identity };

  try {
    if (flow.intent === "link") {
      const user = await currentUser();
      if (!user || user.id !== flow.userId) return go("/signin");
      await asAuth(getDb(), (tx) => linkIdentity(tx, user.id, claims));
      return go("/security");
    }
    const r = await asAuth(getDb(), (tx) => oidcSignIn(tx, claims, locale));
    const [u] = await asAuth(getDb(), (tx) =>
      tx.select({ totp: schema.users.totpEnabledAt }).from(schema.users).where(eq(schema.users.id, r.userId)),
    );
    await destroySession();
    await createSession(r.userId, false);
    if (u?.totp) return go("/signin/2fa");
    return go(flow.next ?? "/homes");
  } catch (e) {
    if (e instanceof DomainError) return go(`${failTo}?error=${errorCode(e)}`);
    throw e;
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  return handle(request, (await params).provider, request.nextUrl.searchParams);
}

/** Apple (response_mode=form_post). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const form = await request.formData();
  const p = new URLSearchParams();
  for (const k of ["code", "state", "user"]) {
    const v = form.get(k);
    if (typeof v === "string") p.set(k, v);
  }
  return handle(request, (await params).provider, p);
}
