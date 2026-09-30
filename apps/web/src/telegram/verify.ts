import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Server-side checks of data that claims to come from Telegram (plan: security checklist,
// "Telegram Login and Mini App initData are verified with HMAC on the server").

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

const safeEqualHex = (a: string, b: string) =>
  /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/**
 * Mini App: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * secret = HMAC_SHA256(key "WebAppData", bot token); hash = HMAC_SHA256(secret, check string).
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 3600,
  now = Date.now(),
): { user: TelegramUser; startParam: string | null; authDate: number } | null {
  if (!initData || initData.length > 4096 || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") ?? "";
  params.delete("hash");
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  if (!safeEqualHex(hash, expected)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSeconds || authDate - now / 1000 > 60) return null;
  let user: TelegramUser;
  try {
    user = JSON.parse(params.get("user") ?? "null");
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
  return { user, startParam: params.get("start_param"), authDate };
}

/**
 * Login Widget: https://core.telegram.org/widgets/login#checking-authorization
 * secret = SHA256(bot token); hash = HMAC_SHA256(secret, check string).
 */
export function verifyLoginWidget(
  data: Record<string, string>,
  botToken: string,
  maxAgeSeconds = 600,
  now = Date.now(),
): TelegramUser | null {
  if (!botToken) return null;
  const { hash = "", ...rest } = data;
  const allowed = ["id", "first_name", "last_name", "username", "photo_url", "auth_date"];
  const check = Object.keys(rest)
    .filter((k) => allowed.includes(k))
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  if (!safeEqualHex(hash, expected)) return null;
  const authDate = Number(rest.auth_date);
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSeconds) return null;
  const id = Number(rest.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { id, first_name: rest.first_name, last_name: rest.last_name, username: rest.username };
}

/** Constant-time check of the webhook's X-Telegram-Bot-Api-Secret-Token header. */
export function checkWebhookSecret(header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
