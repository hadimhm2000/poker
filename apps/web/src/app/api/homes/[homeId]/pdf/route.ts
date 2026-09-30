import { asUser, homePlan } from "@poker/db";
import { type NextRequest, NextResponse } from "next/server";
import { locales } from "@/i18n/routing";
import { SESSION_COOKIE, currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { loadHomeResults } from "@/lib/home";
import { pdfEnabled, renderPdf } from "@/lib/pdf";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Two-page statistics PDF (like sheets 2 and 3), rendered on the server. Pro, like the other exports. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ homeId: string }> }) {
  if (!pdfEnabled()) return new NextResponse("Not found", { status: 404 });
  const { homeId } = await params;
  const user = await currentUser();
  if (!user || user.needsTwoFactor) return new NextResponse("Unauthorized", { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(homeId)) return new NextResponse("Not found", { status: 404 });
  if (!rateLimit(`pdf:${user.id}`, 5, 10 * 60e3)) return new NextResponse("Too many requests", { status: 429 });
  const data = await asUser(getDb(), user.id, async (tx) => {
    const loaded = await loadHomeResults(tx, homeId);
    return loaded && { name: loaded.home.name, plan: await homePlan(tx, homeId) };
  });
  if (!data) return new NextResponse("Not found", { status: 404 });
  if (data.plan !== "pro") return new NextResponse("Exports are a Pro feature", { status: 402 });

  const locale = locales.find((l) => l === request.nextUrl.searchParams.get("locale")) ?? user.locale;
  // Render from this server itself, never from a host named in the request.
  const origin = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const token = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  let pdf: Buffer;
  try {
    pdf = await renderPdf(`${origin}/${locale}/homes/${homeId}/stats`, { name: SESSION_COOKIE, value: token });
  } catch (e) {
    console.error("pdf failed", (e as Error).message);
    return new NextResponse("PDF failed", { status: 500 });
  }
  const safeName = data.name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 40) || "poker-home";
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="poker-home.pdf"; filename*=UTF-8''${encodeURIComponent(safeName)}.pdf`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
