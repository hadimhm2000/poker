import "server-only";
import { createHmac, hkdfSync } from "node:crypto";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { sha256 } from "./crypto";

// Join links for a game's QR code. The token is an HMAC of the invite id under a key derived
// from FIELD_KEY, so the database keeps only its hash and the host's page can redraw the QR.
function joinKey(): Buffer {
  const master = Buffer.from(process.env.FIELD_KEY ?? "", "base64");
  if (master.length !== 32) throw new Error("FIELD_KEY must be 32 bytes, base64");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "poker-home/join-token", 32));
}

export const joinToken = (inviteId: string) => createHmac("sha256", joinKey()).update(inviteId).digest("base64url");
export const joinTokenHash = (inviteId: string) => sha256(joinToken(inviteId));

/** Public origin of the site: APP_URL in production, else the request's own host. */
export async function appOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export const qrDataUrl = (text: string) => QRCode.toDataURL(text, { margin: 1, width: 260, errorCorrectionLevel: "M" });
