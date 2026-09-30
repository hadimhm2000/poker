import "server-only";
import { asAuth, createEmailToken } from "@poker/db";
import { getTranslations } from "next-intl/server";
import { randomToken, sha256 } from "./crypto";
import { appOrigin } from "./live";
import { getDb } from "./db";
import { sendMail } from "./mail";

const VERIFY_TTL = 48 * 3600e3;
const RESET_TTL = 30 * 60e3;

/** Email a one-time link to confirm the address. Only the token's hash is stored. */
export async function sendVerificationEmail(u: { id: string; email: string; locale: string }) {
  const token = randomToken();
  await asAuth(getDb(), (tx) =>
    createEmailToken(tx, { hash: sha256(token), userId: u.id, purpose: "verify", email: u.email, ttlMs: VERIFY_TTL }),
  );
  const t = await getTranslations({ locale: u.locale, namespace: "email" });
  const link = `${await appOrigin()}/api/auth/verify-email?token=${token}&locale=${u.locale}`;
  return sendMail({ to: u.email, subject: t("verifySubject"), text: t("verifyBody", { link }) });
}

/** Email a 30-minute password reset link. */
export async function sendResetEmail(u: { id: string; email: string; locale: string }) {
  const token = randomToken();
  await asAuth(getDb(), (tx) =>
    createEmailToken(tx, { hash: sha256(token), userId: u.id, purpose: "reset", email: u.email, ttlMs: RESET_TTL }),
  );
  const t = await getTranslations({ locale: u.locale, namespace: "email" });
  const link = `${await appOrigin()}/${u.locale}/reset?token=${token}`;
  return sendMail({ to: u.email, subject: t("resetSubject"), text: t("resetBody", { link }) });
}
