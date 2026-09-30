import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authorizationUrl, newFlow, verifyIdToken } from "./oidc";

let keys: ReturnType<typeof createLocalJWKSet>;
let sign: (claims: Record<string, unknown>, opts?: { iss?: string; aud?: string; exp?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
  sign = (claims, o = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(o.iss ?? "https://accounts.google.com")
      .setAudience(o.aud ?? "client-1")
      .setIssuedAt()
      .setExpirationTime(o.exp ?? "5m")
      .sign(privateKey);
});

describe("ID token check", () => {
  const good = { sub: "123", email: "sara@example.com", email_verified: true, name: "Sara", nonce: "n1" };

  it("accepts a token for us with our nonce", async () => {
    const v = await verifyIdToken("google", await sign(good), "n1", keys, "client-1");
    expect(v).toEqual({ subject: "123", email: "sara@example.com", emailVerified: true, name: "Sara" });
  });

  it("reads Apple's string flag", async () => {
    const t = await sign({ ...good, email_verified: "true" }, { iss: "https://appleid.apple.com" });
    expect((await verifyIdToken("apple", t, "n1", keys, "client-1")).emailVerified).toBe(true);
  });

  it("refuses a wrong nonce, audience, issuer, an expired token, and a forged signature", async () => {
    await expect(verifyIdToken("google", await sign(good), "other", keys, "client-1")).rejects.toThrow(/nonce/);
    await expect(verifyIdToken("google", await sign(good, { aud: "someone-else" }), "n1", keys, "client-1")).rejects.toThrow();
    await expect(verifyIdToken("google", await sign(good, { iss: "https://evil.example" }), "n1", keys, "client-1")).rejects.toThrow();
    await expect(verifyIdToken("google", await sign(good, { exp: "-10m" }), "n1", keys, "client-1")).rejects.toThrow();
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT(good)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://accounts.google.com")
      .setAudience("client-1")
      .setExpirationTime("5m")
      .sign(other.privateKey);
    await expect(verifyIdToken("google", forged, "n1", keys, "client-1")).rejects.toThrow();
  });
});

describe("authorization URL", () => {
  it("carries state, nonce and PKCE for Google, form_post for Apple", () => {
    const flow = newFlow({ intent: "signin", locale: "fa", next: null, userId: null });
    const g = new URL(authorizationUrl("google", flow, "https://poker.test"));
    expect(g.searchParams.get("state")).toBe(flow.state);
    expect(g.searchParams.get("nonce")).toBe(flow.nonce);
    expect(g.searchParams.get("code_challenge_method")).toBe("S256");
    expect(g.searchParams.get("redirect_uri")).toBe("https://poker.test/api/auth/google/callback");
    const a = new URL(authorizationUrl("apple", flow, "https://poker.test"));
    expect(a.searchParams.get("response_mode")).toBe("form_post");
    expect(a.searchParams.get("code_challenge")).toBeNull();
  });
});
