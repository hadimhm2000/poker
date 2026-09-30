import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkWebhookSecret, verifyInitData, verifyLoginWidget } from "./verify";

const TOKEN = "123456:TEST-token";
const now = 1_790_000_000_000;

function signInitData(fields: Record<string, string>, token = TOKEN) {
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 42, first_name: "Hadi", language_code: "fa" });
const fresh = String(Math.floor(now / 1000) - 10);

describe("Mini App initData", () => {
  it("accepts correctly signed, fresh data", () => {
    const r = verifyInitData(signInitData({ user, auth_date: fresh, start_param: "game_x", query_id: "q" }), TOKEN, 3600, now);
    expect(r?.user.id).toBe(42);
    expect(r?.startParam).toBe("game_x");
  });
  it("rejects a changed field", () => {
    const s = signInitData({ user, auth_date: fresh }).replace("42", "43");
    expect(verifyInitData(s, TOKEN, 3600, now)).toBeNull();
  });
  it("rejects another bot's signature", () => {
    expect(verifyInitData(signInitData({ user, auth_date: fresh }, "999:other"), TOKEN, 3600, now)).toBeNull();
  });
  it("rejects old data (replay)", () => {
    const old = String(Math.floor(now / 1000) - 7200);
    expect(verifyInitData(signInitData({ user, auth_date: old }), TOKEN, 3600, now)).toBeNull();
  });
  it("rejects missing hash or user", () => {
    expect(verifyInitData(`user=${encodeURIComponent(user)}&auth_date=${fresh}`, TOKEN, 3600, now)).toBeNull();
    expect(verifyInitData(signInitData({ auth_date: fresh }), TOKEN, 3600, now)).toBeNull();
  });
});

describe("Login Widget", () => {
  const sign = (fields: Record<string, string>) => {
    const check = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("\n");
    const secret = createHash("sha256").update(TOKEN).digest();
    return { ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") };
  };
  it("accepts correctly signed data", () => {
    expect(verifyLoginWidget(sign({ id: "42", first_name: "Hadi", auth_date: fresh }), TOKEN, 600, now)?.id).toBe(42);
  });
  it("rejects tampering and stale data", () => {
    expect(verifyLoginWidget({ ...sign({ id: "42", auth_date: fresh }), id: "43" }, TOKEN, 600, now)).toBeNull();
    expect(verifyLoginWidget(sign({ id: "42", auth_date: String(Number(fresh) - 3600) }), TOKEN, 600, now)).toBeNull();
  });
});

describe("webhook secret", () => {
  it("matches only the exact secret", () => {
    expect(checkWebhookSecret("s3cret", "s3cret")).toBe(true);
    expect(checkWebhookSecret("s3cre", "s3cret")).toBe(false);
    expect(checkWebhookSecret(null, "s3cret")).toBe(false);
    expect(checkWebhookSecret("", "")).toBe(false);
  });
});
