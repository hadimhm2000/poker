import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export async function ErrorNotice({ code }: { code?: string }) {
  if (!code) return null;
  const t = await getTranslations("errors");
  const tb = await getTranslations("billing");
  // Any code with a translation in "errors" (they come from errorCode()); anything else is generic.
  const key = /^[A-Z_]+$/.test(code) && t.has(code) ? code : "ERROR";
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
