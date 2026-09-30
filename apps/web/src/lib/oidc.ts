import { createHash, randomBytes } from "node:crypto";
import { type JWTVerifyGetKey, SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from "jose";

/**
 * Sign in with Google and Apple: OpenID Connect authorization code flow with state, nonce and
 * (Google) PKCE. The ID token is verified against the provider's published keys, issuer,
 * audience and our nonce; nothing else from the provider is trusted.
 */

export type ProviderId = "google" | "apple";

interface ProviderConfig {
  issuer: string;
  authorize: string;
  token: string;
  jwks: string;
  scope: string;
  clientId: () => string | undefined;
  /** Google: a static secret. Apple: a short-lived ES256 JWT signed with the team's key. */
  clientSecret: () => Promise<string | undefined>;
  pkce: boolean;
  /** Apple returns to us with a cross-site form POST. */
  formPost: boolean;
}

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  google: {
    issuer: "https://accounts.google.com",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    scope: "openid email profile",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: async () => process.env.GOOGLE_CLIENT_SECRET,
    pkce: true,
    formPost: false,
  },
  apple: {
    issuer: "https://appleid.apple.com",
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    jwks: "https://appleid.apple.com/auth/keys",
    scope: "name email",
    clientId: () => process.env.APPLE_CLIENT_ID,
    clientSecret: appleClientSecret,
    pkce: false,
    formPost: true,
  },
};

export const isProvider = (p: string): p is ProviderId => p === "google" || p === "apple";

export function providerEnabled(p: ProviderId): boolean {
  if (p === "google") return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return !!(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
}

export const usesFormPost = (p: ProviderId) => PROVIDERS[p].formPost;

async function appleClientSecret(): Promise<string | undefined> {
  const { APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY } = process.env;
  if (!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) return undefined;
  const key = await importPKCS8(APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APPLE_KEY_ID })
    .setIssuer(APPLE_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setAudience("https://appleid.apple.com")
    .setSubject(APPLE_CLIENT_ID)
    .sign(key);
}

export interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  intent: "signin" | "link";
  locale: string;
  next: string | null;
  /** For "link": the account that started it; the callback must be the same session. */
  userId: string | null;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function newFlow(input: Pick<FlowState, "intent" | "locale" | "next" | "userId">): FlowState {
  return { ...input, state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(32)) };
}

export const redirectUri = (appUrl: string, p: ProviderId) => `${appUrl}/api/auth/${p}/callback`;

export function authorizationUrl(p: ProviderId, flow: FlowState, appUrl: string): string {
  const c = PROVIDERS[p];
  const url = new URL(c.authorize);
  url.searchParams.set("client_id", c.clientId() ?? "");
  url.searchParams.set("redirect_uri", redirectUri(appUrl, p));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", c.scope);
  url.searchParams.set("state", flow.state);
  url.searchParams.set("nonce", flow.nonce);
  if (c.pkce) {
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(flow.verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
  }
  if (c.formPost) url.searchParams.set("response_mode", "form_post");
  return url.toString();
}

/** Trade the one-time code for tokens (server to server). */
export async function exchangeCode(p: ProviderId, code: string, flow: FlowState, appUrl: string): Promise<string> {
  const c = PROVIDERS[p];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(appUrl, p),
    client_id: c.clientId() ?? "",
    client_secret: (await c.clientSecret()) ?? "",
  });
  if (c.pkce) body.set("code_verifier", flow.verifier);
  const res = await fetch(c.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("no id_token");
  return json.id_token;
}

const keySets = new Map<ProviderId, JWTVerifyGetKey>();
const remoteKeys = (p: ProviderId) => {
  let k = keySets.get(p);
  if (!k) keySets.set(p, (k = createRemoteJWKSet(new URL(PROVIDERS[p].jwks))));
  return k;
};

export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** Check the ID token's signature, issuer, audience, expiry and nonce. */
export async function verifyIdToken(
  p: ProviderId,
  idToken: string,
  nonce: string,
  keys: JWTVerifyGetKey = remoteKeys(p),
  clientId = PROVIDERS[p].clientId(),
): Promise<VerifiedIdentity> {
  if (!clientId) throw new Error("provider not configured");
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: PROVIDERS[p].issuer,
    audience: clientId,
    clockTolerance: 60,
  });
  if (payload.nonce !== nonce) throw new Error("nonce mismatch");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("no subject");
  const email = typeof payload.email === "string" ? payload.email : null;
  // Apple sends the flag as a string.
  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  const name = typeof payload.name === "string" ? payload.name : null;
  return { subject: payload.sub, email, emailVerified, name };
}
