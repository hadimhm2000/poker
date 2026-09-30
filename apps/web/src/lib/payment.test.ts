import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

beforeAll(() => {
  process.env.FIELD_KEY = randomBytes(32).toString("base64");
});

describe("payment details", () => {
  it("round-trip through AES-256-GCM and never store the plain text", async () => {
    const { openPayment, sealPayment } = await import("./payment");
    const text = "IR12 3456 7890 1234 5678 9012 34 (Hadi)";
    const blob = sealPayment(text)!;
    expect(blob.includes(Buffer.from("3456"))).toBe(false);
    expect(openPayment(blob)).toBe(text);
    // A fresh IV each time.
    expect(sealPayment(text)!.equals(blob)).toBe(false);
    expect(sealPayment("")).toBeNull();
    expect(openPayment(null)).toBeNull();
  });

  it("a tampered or foreign ciphertext reads as nothing", async () => {
    const { openPayment, sealPayment } = await import("./payment");
    const blob = sealPayment("paypal.me/hadi")!;
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect(openPayment(blob)).toBeNull();
    expect(openPayment(randomBytes(40))).toBeNull();
  });
});

describe("invite tokens", () => {
  it("are stable per invite, URL-safe, and differ from game join tokens", async () => {
    const { inviteToken, inviteTokenHash, joinToken } = await import("./live");
    const id = "6f1c1c1e-8a4e-4a0e-9d2b-0d7c4c3b2a19";
    expect(inviteToken(id)).toBe(inviteToken(id));
    expect(inviteToken(id)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inviteToken(id)).not.toBe(joinToken(id));
    expect(inviteTokenHash(id)).toHaveLength(32);
  });
});
