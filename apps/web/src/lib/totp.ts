import "server-only";
import { cookies } from "next/headers";
import { Secret, TOTP } from "otpauth";
import { decryptField } from "./crypto";

export const PENDING_TOTP = "totp_pending";

export function totpFor(secretBase32: string, label: string) {
  return new TOTP({
    issuer: "Poker Home",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** The secret being set up (from the encrypted, 10-minute cookie), or null. */
export async function pendingTotpSecret(): Promise<string | null> {
  const pending = (await cookies()).get(PENDING_TOTP)?.value;
  if (!pending) return null;
  try {
    return decryptField(Buffer.from(pending, "base64url"));
  } catch {
    return null;
  }
}
