import { schema } from "@poker/db";
import { asUser, eq } from "@poker/db";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { onGameChange } from "@/lib/realtime";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-Sent Events: "change" whenever the game changes. Members of the game's home only. */
export async function GET(request: Request, { params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  if (!UUID.test(gameId)) return new Response(null, { status: 404 });
  const user = await currentUser();
  if (!user || user.needsTwoFactor) return new Response(null, { status: 401 });
  const [game] = await asUser(getDb(), user.id, (tx) =>
    tx.select({ status: schema.games.status }).from(schema.games).where(eq(schema.games.id, gameId)),
  );
  if (!game) return new Response(null, { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Coalesce bursts (one host tap can touch several rows) into one event.
      const off = await onGameChange(gameId, () => {
        clearTimeout(timer);
        timer = setTimeout(() => send(`event: change\ndata: ${Date.now()}\n\n`), 150);
      });
      const ping = setInterval(() => send(": ping\n\n"), 25_000);
      cleanup = () => {
        off();
        clearInterval(ping);
        clearTimeout(timer);
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", () => cleanup());
      send("retry: 3000\n\n");
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
