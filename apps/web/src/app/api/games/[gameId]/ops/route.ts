import { DomainError, applyHostOp } from "@poker/db";
import { asUser } from "@poker/db";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { errorCode } from "@/lib/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * One queued change from the host's phone (rebuy, cash-out, answer to a request).
 * Idempotent by opKey, so the phone can resend after a dropped connection.
 * 4xx means "drop it and show why"; 5xx or no answer means "keep it and retry".
 */
export async function POST(request: Request, { params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  if (!UUID.test(gameId)) return json({ error: "NOT_FOUND" }, 404);
  if (!isSameOrigin(request)) return json({ error: "FORBIDDEN" }, 403);
  const user = await currentUser();
  if (!user || user.needsTwoFactor) return json({ error: "UNAUTHORIZED" }, 401);
  if (!rateLimit(`ops:${user.id}`, 120, 60e3)) return json({ error: "rateLimited" }, 429);
  const body = await request.json().catch(() => null);
  try {
    const r = await asUser(getDb(), user.id, (tx) => applyHostOp(tx, user.id, gameId, body));
    return json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof z.ZodError) return json({ error: "INVALID" }, 400);
    if (e instanceof DomainError) return json({ error: e.code }, 409);
    const code = errorCode(e);
    if (code === "ERROR") {
      console.error("ops failed", e);
      return json({ error: code }, 500);
    }
    return json({ error: code }, 409);
  }
}
