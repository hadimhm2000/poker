import { asUser } from "@poker/db";
import { type NextRequest, NextResponse } from "next/server";
import { locales } from "@/i18n/routing";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { appOrigin } from "@/lib/live";
import { resultCardPng } from "@/lib/result-card";
import { errorCode } from "@/lib/session";

/** The result card of a closed game as a PNG, for members of its home. ?f=story for 9:16. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const user = await currentUser();
  if (!user || user.needsTwoFactor) return new NextResponse("Unauthorized", { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(gameId)) return new NextResponse("Not found", { status: 404 });
  const format = request.nextUrl.searchParams.get("f") === "story" ? "story" : "post";
  // The language of the page the person is on (sent by the page); unknown values fall back to the home's own.
  const language = locales.find((l) => l === request.nextUrl.searchParams.get("locale"));
  const origin = await appOrigin();
  try {
    const card = await asUser(getDb(), user.id, (tx) => resultCardPng(tx, gameId, origin, format, language));
    const download = request.nextUrl.searchParams.has("download");
    return new NextResponse(new Uint8Array(card.png), {
      headers: {
        "Content-Type": "image/png",
        // Frozen results never change, but the card is private to the home's members.
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        ...(download
          ? { "Content-Disposition": `attachment; filename="poker-home-${card.number}${format === "story" ? "-story" : ""}.png"` }
          : {}),
      },
    });
  } catch (e) {
    const code = errorCode(e);
    if (code === "NOT_FOUND" || code === "NOT_CLOSED") return new NextResponse("Not found", { status: 404 });
    throw e;
  }
}
