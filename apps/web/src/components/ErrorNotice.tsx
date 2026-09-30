import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

const KNOWN = ["INVALID", "LIMIT", "READ_ONLY", "FROZEN", "DUPLICATE", "FORBIDDEN", "ERROR", "NOT_FOUND", "STALE", "BLOCKED", "NOT_IN_GAME"] as const;

export async function ErrorNotice({ code }: { code?: string }) {
  if (!code) return null;
  const t = await getTranslations("errors");
  const tb = await getTranslations("billing");
  const key = (KNOWN as readonly string[]).includes(code) ? (code as (typeof KNOWN)[number]) : "ERROR";
  return (
    <div className="alert" role="alert">
      {t(key)}
      {(key === "LIMIT" || key === "READ_ONLY") && (
        <>
          {" "}
          <Link href="/pricing">{tb("upgradeLink")}</Link>
        </>
      )}
    </div>
  );
}
