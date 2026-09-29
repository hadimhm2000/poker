/**
 * Tamper-evident result chain. Each closed game stores
 *   hash = SHA-256(prevHash + "\n" + canonicalJSON(result))
 * so changing any old game breaks every hash after it. The result card QR links to a page
 * that recomputes this in the browser (Web Crypto works in Node 22 and all browsers).
 */
export const GENESIS_HASH = "0".repeat(64);

export interface HashableGame {
  homeId: string;
  number: number;
  closedAt: string; // ISO 8601
  currency: string | null;
  entries: { playerId: string; totalIn: number; cashOut: number }[];
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashPayload(game: HashableGame): HashableGame {
  // Entry order must not depend on insertion order.
  const entries = [...game.entries].sort((a, b) =>
    a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0,
  );
  return { ...game, entries };
}

export async function gameHash(prevHash: string, game: HashableGame): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(prevHash)) throw new Error("prevHash must be 64 hex chars");
  const data = new TextEncoder().encode(`${prevHash}\n${canonicalJson(hashPayload(game))}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ChainLink {
  game: HashableGame;
  prevHash: string;
  hash: string;
}

/** Returns the index of the first broken link, or -1 when the whole chain verifies. */
export async function verifyChain(links: readonly ChainLink[]): Promise<number> {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    if (link.prevHash !== expectedPrev) return i;
    if ((await gameHash(link.prevHash, link.game)) !== link.hash) return i;
    expectedPrev = link.hash;
  }
  return -1;
}
