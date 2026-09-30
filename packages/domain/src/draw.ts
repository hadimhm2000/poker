/**
 * Verifiable fair draw (commit-reveal) for seat order and the first dealer.
 *
 *   1. The server picks a random 32-byte seed and publishes commit = SHA-256(seed) before
 *      anyone can know the result.
 *   2. While the draw is open, each player may add a 32-byte contribution from their phone.
 *   3. The host reveals the seed. Anyone checks SHA-256(seed) = commit, then recomputes:
 *        key   = SHA-256(seed || contribution_1 || ... || contribution_n)
 *                (contributions ordered by player id; raw bytes, 32 each)
 *        order = Fisher-Yates shuffle of the player ids sorted ascending, where the n-th
 *                random 32-bit number is taken from SHA-256(key || uint32be(block)),
 *                with rejection sampling so every order is equally likely.
 *      The seat order is `order`; the player in seat 1 deals first.
 *
 * Nobody controls the result: the server committed before the contributions, and players
 * cannot predict the seed, so a late contribution cannot steer it either.
 */

export const DRAW_HEX = /^[0-9a-f]{64}$/;

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export async function drawCommit(seedHex: string): Promise<string> {
  if (!DRAW_HEX.test(seedHex)) throw new Error("seed must be 64 hex characters");
  return bytesToHex(await sha256(hexToBytes(seedHex)));
}

export interface DrawInput {
  seed: string;
  /** Player ids taking part (any order; they are sorted). */
  players: readonly string[];
  contributions: readonly { playerId: string; value: string }[];
}

export interface DrawStep {
  /** Fisher-Yates position being filled (counting down). */
  i: number;
  /** Position swapped into it, uniform in 0..i. */
  j: number;
}

export interface DrawResult {
  key: string;
  /** Player ids in seat order; order[0] deals first. */
  order: string[];
  /** The players sorted by id: the starting order of the shuffle. */
  sorted: string[];
  steps: DrawStep[];
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function drawKey(input: DrawInput): Promise<string> {
  if (!DRAW_HEX.test(input.seed)) throw new Error("seed must be 64 hex characters");
  const players = new Set(input.players);
  const seen = new Set<string>();
  for (const c of input.contributions) {
    if (!players.has(c.playerId)) throw new Error("contribution from someone outside the draw");
    if (seen.has(c.playerId)) throw new Error("one contribution per player");
    if (!DRAW_HEX.test(c.value)) throw new Error("contribution must be 64 hex characters");
    seen.add(c.playerId);
  }
  const parts = [input.seed, ...[...input.contributions].sort((a, b) => byId(a.playerId, b.playerId)).map((c) => c.value)];
  return bytesToHex(await sha256(hexToBytes(parts.join(""))));
}

/** Deterministic stream of uniform 32-bit numbers from the key. */
function randomStream(key: Uint8Array) {
  let block = 0;
  let buf: DataView | null = null;
  let pos = 0;
  return async (): Promise<number> => {
    if (!buf || pos >= 32) {
      const input = new Uint8Array(key.length + 4);
      input.set(key);
      new DataView(input.buffer).setUint32(key.length, block++);
      buf = new DataView((await sha256(input)).buffer);
      pos = 0;
    }
    const v = buf.getUint32(pos);
    pos += 4;
    return v;
  };
}

/** A number in 0..bound-1 without modulo bias. */
async function uniform(next: () => Promise<number>, bound: number): Promise<number> {
  const limit = Math.floor(2 ** 32 / bound) * bound;
  for (;;) {
    const x = await next();
    if (x < limit) return x % bound;
  }
}

export async function drawOrder(input: DrawInput): Promise<DrawResult> {
  const sorted = [...new Set(input.players)].sort(byId);
  if (sorted.length !== input.players.length) throw new Error("duplicate player");
  const key = await drawKey(input);
  const next = randomStream(hexToBytes(key));
  const order = [...sorted];
  const steps: DrawStep[] = [];
  for (let i = order.length - 1; i > 0; i--) {
    const j = await uniform(next, i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
    steps.push({ i, j });
  }
  return { key, order, sorted, steps };
}

export interface DrawCheck {
  /** SHA-256(seed) equals the published commit. */
  commitOk: boolean;
  result: DrawResult;
}

/** Everything a viewer needs to trust the draw: the commit matches and the order follows. */
export async function verifyDraw(commit: string, input: DrawInput): Promise<DrawCheck> {
  return { commitOk: (await drawCommit(input.seed)) === commit, result: await drawOrder(input) };
}

export function randomHex32(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}
