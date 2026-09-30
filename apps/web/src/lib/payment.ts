import "server-only";
import { decryptField, encryptField } from "./crypto";

// Payment details (card number, IBAN, PayPal) are stored AES-256-GCM encrypted per field.
// Members of the home read them to pay a debt; they never go into logs or the audit log.

/** Ciphertext for the database, or null to clear. */
export function sealPayment(text: string): Buffer | null {
  return text ? encryptField(text) : null;
}

/** The plain text, or null when there is none or it cannot be decrypted (e.g. a rotated key). */
export function openPayment(blob: Buffer | Uint8Array | null | undefined): string | null {
  if (!blob) return null;
  try {
    return decryptField(Buffer.from(blob));
  } catch {
    return null;
  }
}
