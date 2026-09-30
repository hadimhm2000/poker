import nodemailer, { type Transporter } from "nodemailer";

/**
 * Outgoing email (verification, password reset, game-night reminders). SMTP_URL is any SMTP
 * provider, e.g. smtps://user:pass@smtp.example.com:465. Without it, development prints the
 * message to the server log and production sends nothing (the caller carries on).
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

let transport: Transporter | null | undefined;

export function mailConfigured(): boolean {
  return !!process.env.SMTP_URL;
}

export async function sendMail(m: Mail): Promise<boolean> {
  if (transport === undefined) transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
  if (!transport) {
    if (process.env.NODE_ENV !== "production") console.info(`[mail] to ${m.to}: ${m.subject}\n${m.text}`);
    else console.warn("[mail] SMTP_URL is not set; email not sent");
    return false;
  }
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM ?? "Poker Home <no-reply@localhost>", ...m });
    return true;
  } catch (e) {
    // Never log the message itself: it carries a one-time link.
    console.error("[mail] send failed", (e as Error).message);
    return false;
  }
}
