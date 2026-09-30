import "server-only";
import { EventEmitter } from "node:events";
import { listenGameChanges } from "@poker/db";

// Live game updates: Postgres NOTIFY (sent by triggers on every game change) fanned out to
// the Server-Sent-Event streams of this process. Works on any number of server instances,
// since each one listens for itself. The payload is only a game id; pages re-read through RLS.
interface Realtime {
  emitter: EventEmitter;
  ready: Promise<unknown>;
}
const g = globalThis as unknown as { pokerRealtime?: Realtime };

function realtime(): Realtime {
  if (!g.pokerRealtime) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    const ready = listenGameChanges(url, (gameId) => emitter.emit(gameId)).catch((e: unknown) => {
      g.pokerRealtime = undefined;
      throw e;
    });
    g.pokerRealtime = { emitter, ready };
  }
  return g.pokerRealtime;
}

export async function onGameChange(gameId: string, fn: () => void): Promise<() => void> {
  const r = realtime();
  await r.ready;
  r.emitter.on(gameId, fn);
  return () => r.emitter.off(gameId, fn);
}
