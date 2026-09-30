import { applyBillingEvent, asBilling } from "@poker/db";
import { getDb } from "@/lib/db";
import { parsePaddleEvent, verifyPaddleSignature } from "@/lib/paddle";

export const dynamic = "force-dynamic";

const MAX_BODY = 256 * 1024;

/**
 * Paddle → plan. The signature (HMAC of the raw body with the endpoint secret, fresh within
 * 5 minutes) is checked before anything is parsed; the change is applied through the
 * app_billing role, idempotent by event id. Paddle retries anything that is not a 2xx.
 */
export async function POST(request: Request) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET ?? "";
  if (!secret) return new Response(null, { status: 503 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return new Response(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response(null, { status: 413 });
  if (!verifyPaddleSignature(request.headers.get("paddle-signature"), raw, secret)) {
    return new Response(null, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  const parsed = parsePaddleEvent(body);
  if (parsed.kind === "invalid") return new Response(null, { status: 400 });
  if (parsed.kind === "ignore") return new Response(null, { status: 200 });

  try {
    const outcome = await asBilling(getDb(), (tx) => applyBillingEvent(tx, parsed.event));
    // Ids only: payloads hold names, emails and addresses.
    if (outcome === "unmapped") console.warn("billing event without a known user", parsed.event.eventId, parsed.event.subscriptionId);
    return Response.json({ ok: true, outcome });
  } catch (e) {
    console.error("billing event failed", parsed.event.eventId, e instanceof Error ? e.message : e);
    return new Response(null, { status: 500 });
  }
}
