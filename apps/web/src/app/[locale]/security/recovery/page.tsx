import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { dismissRecoveryCodesAction } from "@/app/actions/auth";
import { Link } from "@/i18n/navigation";
import { decryptField } from "@/lib/crypto";
import { RECOVERY_FLASH } from "@/lib/recovery";
import { requireUser } from "@/lib/session";

/** Shows freshly made recovery codes once (they live 5 minutes in an encrypted cookie). */
export default async function RecoveryCodes() {
  await requireUser();
  const t = await getTranslations("auth");
  const raw = (await cookies()).get(RECOVERY_FLASH)?.value;
  let codes: string[] = [];
  try {
    if (raw) codes = decryptField(Buffer.from(raw, "base64url")).split(" ");
  } catch {}
  return (
    <div className="card stack" style={{ maxWidth: 480, marginInline: "auto" }}>
      <h1>{t("recoveryTitle")}</h1>
      {codes.length ? (
        <>
          <p>{t("recoveryIntro")}</p>
          <pre className="break mono recovery-codes">{codes.join("\n")}</pre>
          <form action={dismissRecoveryCodesAction}>
            <button className="btn" type="submit">
              {t("recoverySaved")}
            </button>
          </form>
        </>
      ) : (
        <p className="muted">
          {t("recoveryGone")} <Link href="/security">{t("securityTitle")}</Link>
        </p>
      )}
    </div>
  );
}
