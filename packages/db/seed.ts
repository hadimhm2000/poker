/**
 * Seed the dev database with a realistic Persian poker home, through the app's own domain
 * functions (hash chains, triggers, settlements are all real):
 *   - pro user hadi@local with a pre-forged session (cookie "devsession")
 *   - 8 players, 48 imported weekly games (toman), payment details for three players
 *   - game 49 force-closed with NO players (the games-count bug: 49 games, 48 with rows)
 *   - two live games closed normally → open debts in the ledger
 * Run from packages/db:  FIELD_KEY=… tsx ../../scripts/seed.ts
 */
import { createHmac, createHash, hkdfSync, randomBytes, createCipheriv } from "node:crypto";
import { migrate } from "./src/migrate";
import { sql } from "drizzle-orm";
import { createDb, asUser } from "./src/client";
import { addPlayer, closeGame, createGame, createHome, importGame, setCashOut, addToGame } from "./src/repo";

const ADMIN = "postgres://postgres@127.0.0.1:5433/poker_dev";
const FIELD_KEY = process.env.FIELD_KEY;
if (!FIELD_KEY) throw new Error("FIELD_KEY (base64, 32 bytes) is required");

async function resetDatabase() {
  const postgres = (await import("postgres")).default;
  const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  await admin`DROP SCHEMA IF EXISTS public CASCADE`;
  await admin`DROP SCHEMA IF EXISTS app CASCADE`;
  await admin`CREATE SCHEMA public`;
  await admin.end();
  await migrate(ADMIN);
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest();
const derivedKey = (info: string) => Buffer.from(hkdfSync("sha256", Buffer.from(FIELD_KEY!, "base64"), Buffer.alloc(0), info, 32));

function encryptField(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(FIELD_KEY!, "base64"), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

// deterministic "random" so every reseed makes the same home
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const NAMES = ["هادی", "ابوالفضل", "رضا", "سارا", "امیر", "محمدعلی", "مهدی", "کیان"];
const CARDS = ["6037-9977-1234-5678", "6219-8610-1111-2222", "6274-1200-3333-4444"];

/** Random zero-sum results for the seated players (amounts in smallest units). */
function results(seated: string[]) {
  const ins = seated.map(() => (300 + Math.floor(rnd() * 12) * 100) * 1000);
  const total = ins.reduce((a, b) => a + b, 0);
  let left = total;
  const out = seated.map((_, i) => {
    const last = i === seated.length - 1;
    const share = last ? left : Math.max(0, Math.round((left * (0.4 + rnd() * 0.9)) / (seated.length - i)));
    const cap = Math.min(share, left);
    left -= cap;
    return cap;
  });
  out[0]! += left;
  return seated.map((name, i) => ({ name, totalIn: ins[i]!, cashOut: out[i]! }));
}

async function main() {
  await resetDatabase();
  const { db, client } = createDb(ADMIN, { max: 1 });

  // user + session + home + players, as the superuser (seed only)
  const userId = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO users(email, email_verified_at, display_name, locale, plan)
      VALUES ('hadi@local', now(), 'هادی', 'fa', 'pro')
      RETURNING id`)
  )[0]!.id;
  await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
  await db.execute(sql`
    INSERT INTO sessions(user_id, token_hash, expires_at, two_factor_passed)
    VALUES (${userId}, ${sha256("devsession")}, now() + interval '30 days', true)`);

  const home = await asUser(db, userId, (tx) =>
    createHome(tx, userId, {
      name: "پوکر چهارشنبه‌ها",
      currency: null,
      unitSuffix: "تومان",
      unitDivisor: 1,
      locale: "fa",
      requireConfirmation: false,
    }),
  );
  await db.execute(sql`UPDATE home_members SET player_id = NULL WHERE home_id = ${home.id} AND user_id = ${userId}`);

  const ids = new Map<string, string>();
  for (const n of NAMES) ids.set(n, (await asUser(db, userId, (tx) => addPlayer(tx, home.id, n))).id);
  // link the host to their own player row
  await db.execute(sql`UPDATE players SET user_id = ${userId}, avatar = '🦊' WHERE id = ${ids.get("هادی")}`);
  await db.execute(sql`UPDATE home_members SET player_id = ${ids.get("هادی")} WHERE home_id = ${home.id} AND user_id = ${userId}`);
  await db.execute(sql`UPDATE players SET avatar = '🐼' WHERE id = ${ids.get("سارا")}`);
  await db.execute(sql`UPDATE players SET avatar = '🐯' WHERE id = ${ids.get("رضا")}`);
  for (const [name, card] of [["سارا", CARDS[0]], ["امیر", CARDS[1]], ["هادی", CARDS[2]]] as const) {
    await asUser(db, userId, (tx) => tx.execute(sql`SELECT app.set_player_payment(${ids.get(name)}, ${encryptField(card)})`));
  }

  // 48 imported games, weekly from Nov 2025 (settlements recorded as already paid)
  const start = new Date("2025-11-05T21:30:00Z").getTime();
  for (let g = 1; g <= 48; g++) {
    const when = new Date(start + g * 7 * 864e5);
    const seated = [...NAMES].sort(() => rnd() - 0.5).slice(0, 6 + Math.floor(rnd() * 3));
    await asUser(db, userId, (tx) => importGame(tx, userId, { homeId: home.id, playedAt: when, rows: results(seated) }));
  }

  // game 49: force-closed with nobody at the table (the games-count undercount bug)
  await asUser(db, userId, async (tx) => {
    const g = await createGame(tx, userId, home.id, 0);
    const [{ version }] = await tx.execute<{ version: number }>(sql`SELECT version FROM games WHERE id = ${g.id}`);
    await closeGame(tx, userId, { gameId: g.id, closeKey: crypto.randomUUID(), expectedVersion: version, force: true, carryDebts: false });
  });

  // two games closed normally → open debts for the ledger / debts sheet
  for (let k = 0; k < 2; k++) {
    await asUser(db, userId, async (tx) => {
      const g = await createGame(tx, userId, home.id, 800000);
      const seated = [...NAMES].sort(() => rnd() - 0.5).slice(0, 6);
      const res = results(seated);
      for (const r of res) {
        await addToGame(tx, userId, g.id, ids.get(r.name)!, r.totalIn);
        await setCashOut(tx, userId, g.id, ids.get(r.name)!, r.cashOut);
      }
      const [{ version }] = await tx.execute<{ version: number }>(sql`SELECT version FROM games WHERE id = ${g.id}`);
      await closeGame(tx, userId, { gameId: g.id, closeKey: crypto.randomUUID(), expectedVersion: version, force: false, carryDebts: false });
    });
  }

  const counts = (
    await db.execute<{ games: number; players: number; open_debts: number }>(sql`
      SELECT (SELECT count(*) FROM games WHERE home_id = ${home.id} AND status = 'closed') AS games,
             (SELECT count(*) FROM players WHERE home_id = ${home.id} AND merged_into IS NULL) AS players,
             (SELECT count(*) FROM open_debts WHERE home_id = ${home.id}) AS open_debts`)
  )[0]!;
  console.log("seeded home", home.id, "user", userId, counts);
  await client.end();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
