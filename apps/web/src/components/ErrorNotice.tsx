import { getTranslations } from "next-intl/server";

const KNOWN = ["INVALID", "LIMIT", "READ_ONLY", "FROZEN", "DUPLICATE", "FORBIDDEN", "ERROR", "NOT_FOUND", "STALE", "BLOCKED", "NOT_IN_GAME"] as const;

export async function ErrorNotice({ code }: { code?: string }) {
  if (!code) return null;
  const t = await getTranslations("errors");
  const key = (KNOWN as readonly string[]).includes(code) ? (code as (typeof KNOWN)[number]) : "ERROR";
  return (
    <div className="alert" role="alert">
      {t(key)}
    </div>
  );
}
