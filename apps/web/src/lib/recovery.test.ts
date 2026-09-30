import { describe, expect, it } from "vitest";
import { generateRecoveryCodes, hashRecoveryCode, looksLikeTotp, normalizeRecoveryCode } from "./recovery";

describe("recovery codes", () => {
  it("ten distinct, readable codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
  });

  it("typing is forgiving, the hash is not", () => {
    expect(normalizeRecoveryCode(" k7m2p 9qwxt ")).toBe("K7M2P9QWXT");
    expect(hashRecoveryCode("k7m2p-9qwxt").equals(hashRecoveryCode("K7M2P9QWXT"))).toBe(true);
    expect(hashRecoveryCode("K7M2P-9QWXT").equals(hashRecoveryCode("K7M2P-9QWXA"))).toBe(false);
  });

  it("tells an authenticator code from a recovery code", () => {
    expect(looksLikeTotp("123 456")).toBe(true);
    expect(looksLikeTotp("K7M2P-9QWXT")).toBe(false);
  });
});
