import { asUser, homePlan } from "@poker/db";
import { type NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { buildCsv, buildWorkbook } from "@/lib/export";
import { loadHomeResults } from "@/lib/home";

export async function GET(request: NextRequest, { params }: { params: Promise<{ homeId: string }> }) {
  const { homeId } = await params;
  const user = await currentUser();
  if (!user || user.needsTwoFactor) return new NextResponse("Unauthorized", { status: 401 });
  const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "xlsx";

  const data = await asUser(getDb(), user.id, async (tx) => {
    const loaded = await loadHomeResults(tx, homeId);
    return loaded && { ...loaded, plan: await homePlan(tx, homeId) };
  });
  if (!data) return new NextResponse("Not found", { status: 404 });
  if (data.plan !== "pro") return new NextResponse("Exports are a Pro feature", { status: 402 });

  const safeName = data.home.name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 40) || "poker-home";
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (format === "csv") {
    return new NextResponse(await buildCsv(data.home, data.rows), {
      headers: {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="poker-home.csv"; filename*=UTF-8''${encodeURIComponent(safeName)}.csv`,
      },
    });
  }
  const body = await buildWorkbook(data.home, data.rows);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      ...headers,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="poker-home.xlsx"; filename*=UTF-8''${encodeURIComponent(safeName)}.xlsx`,
    },
  });
}
