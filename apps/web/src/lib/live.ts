import "server-only";
import { createHmac, hkdfSync } from "node:crypto";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { sha256 } from "./crypto";

// Join links for a game's QR code and home invite links. The token is an HMAC of the invite id
// under a key derived from FIELD_KEY, so the database keeps only its hash and the host's page
// can redraw the link and QR. Each kind of link has its own derived key.
function derivedKey(info: string): Buffer {
  const master = Buffer.from(process.env.FIELD_KEY ?? "", "base64");
  if (master.length !== 32) throw new Error("FIELD_KEY must be 32 bytes, base64");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
}

export const joinToken = (inviteId: string) =>
  createHmac("sha256", derivedKey("poker-home/join-token")).update(inviteId).digest("base64url");
export const joinTokenHash = (inviteId: string) => sha256(joinToken(inviteId));

export const inviteToken = (inviteId: string) =>
  createHmac("sha256", derivedKey("poker-home/invite-token")).update(inviteId).digest("base64url");
export const inviteTokenHash = (inviteId: string) => sha256(inviteToken(inviteId));

/** Public origin of the site: APP_URL in production, else the request's own host. */
export async function appOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export const qrDataUrl = (text: string) => QRCode.toDataURL(text, { margin: 1, width: 260, errorCorrectionLevel: "M" });
