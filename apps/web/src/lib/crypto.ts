import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest();

export const randomToken = () => randomBytes(32).toString("base64url");

/**
 * Field encryption for payment details and TOTP secrets: AES-256-GCM.
 * FIELD_KEY is 32 bytes base64. In production it comes from the KMS / secret manager.
 * Layout: version(1) | iv(12) | tag(16) | ciphertext
 */
function key(): Buffer {
  const k = Buffer.from(process.env.FIELD_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("FIELD_KEY must be 32 bytes, base64");
  return k;
}

export function encryptField(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function decryptField(blob: Buffer): string {
  if (blob[0] !== 1) throw new Error("unknown field encryption version");
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8");
}
