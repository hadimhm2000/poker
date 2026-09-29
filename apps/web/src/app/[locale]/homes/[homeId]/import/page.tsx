import { eq, schema } from "@poker/db";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ImportForm } from "@/components/ImportForm";
import { Link } from "@/i18n/navigation";
import { withUser } from "@/lib/session";

export default async function ImportPage({ params }: { params: Promise<{ homeId: string }> }) {
  const { homeId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(homeId)) notFound();
  const t = await getTranslations("import");
  const home = await withUser(async (tx) => (await tx.select().from(schema.homes).where(eq(schema.homes.id, homeId)))[0]);
  if (!home) notFound();
  return (
    <>
      <p className="small">
        <Link href={`/homes/${home.id}`}>← {home.name}</Link>
      </p>
      <h1>{t("title")}</h1>
      <p className="muted">{t("intro")}</p>
      <ImportForm homeId={home.id} divisor={home.unitDivisor} suffix={home.unitSuffix} />
    </>
  );
}
