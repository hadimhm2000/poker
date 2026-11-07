/**
 * One-off repair of a home's history after a bad spreadsheet import (admin only).
 * Closed games are frozen by triggers, so this connects as the database owner and switches
 * the freeze triggers off inside one transaction. Nothing is written unless --apply is given:
 * without it everything runs and is rolled back, so you can read the report first.
 *
 *   # 1. delete the wrongly imported games 1..35 (and their settlements, events, drafts...)
 *   pnpm --filter @poker/db fix-history delete --home <homeId> --through 35 [--apply]
 *
 *   # 2. import the corrected Excel on the site (Import page). New games get numbers 49, 50...
 *
 *   # 3. renumber + rebuild the hash chain: the imported games become 1..35 and the kept
 *   #    games (old numbers 36..48) follow as 36..48.
 *   pnpm --filter @poker/db fix-history renumber --home <homeId> --tail-from 36 --tail-to 48 [--apply]
 *
 * Needs DATABASE_URL_ADMIN (the same variable `pnpm migrate` uses).
 */
import { GENESIS_HASH, gameHash, verifyChain } from "@poker/domain";
import postgres from "postgres";

const FREEZE: [string, string][] = [
  ["games", "games_freeze"],
  ["game_entries", "game_entries_freeze"],
  ["game_events", "game_events_freeze"],
  ["settlements", "settlements_freeze"],
];

class DryRun extends Error {}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

type Sql = postgres.TransactionSql;

async function freezeOff(tx: Sql) {
  for (const [table, trigger] of FREEZE) await tx.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
}
async function freezeOn(tx: Sql) {
  for (const [table, trigger] of FREEZE) await tx.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
}

async function run(url: string, apply: boolean, work: (tx: Sql) => Promise<void>) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await freezeOff(tx);
      await work(tx);
      await freezeOn(tx);
      if (!apply) throw new DryRun();
    });
    console.log(apply ? "\nDONE: changes committed." : "");
  } catch (e) {
    if (e instanceof DryRun) console.log("\nDRY RUN: nothing was changed. Add --apply to commit.");
    else throw e;
  } finally {
    await sql.end();
  }
}

async function deleteGames(tx: Sql, home: string, through: number) {
  const target = tx`(SELECT id FROM games WHERE home_id = ${home} AND status = 'closed' AND number <= ${through})`;
  const list = await tx<{ number: number; closed_at: Date; entries: number; total_in: string; max_in: string }[]>`
    SELECT g.number, g.closed_at, count(e.*)::int AS entries, coalesce(sum(e.total_in), 0)::text AS total_in,
           coalesce(max(e.total_in), 0)::text AS max_in
    FROM games g LEFT JOIN game_entries e ON e.game_id = g.id
    WHERE g.home_id = ${home} AND g.status = 'closed' AND g.number <= ${through}
    GROUP BY g.id ORDER BY g.number`;
  if (!list.length) throw new Error("no closed games with that number in this home");
  console.log("Games to delete:");
  for (const g of list) console.log(`  #${g.number}  ${g.closed_at.toISOString().slice(0, 10)}  players=${g.entries}  total in=${g.total_in}  biggest in=${g.max_in}`);

  const settlementIds = tx`(SELECT id FROM settlements WHERE game_id IN ${target})`;
  await tx`DELETE FROM debt_reminders WHERE settlement_id IN ${settlementIds}`;
  await tx`DELETE FROM debt_payments WHERE settlement_id IN ${settlementIds} OR carried_to_game IN ${target}`;
  await tx`DELETE FROM settlements WHERE game_id IN ${target}`;
  await tx`DELETE FROM game_events WHERE game_id IN ${target}`;
  await tx`DELETE FROM game_entries WHERE game_id IN ${target}`;
  await tx`DELETE FROM game_rulings WHERE game_id IN ${target}`;
  await tx`DELETE FROM game_draws WHERE game_id IN ${target}`;
  await tx`DELETE FROM game_stories WHERE game_id IN ${target}`;
  await tx`UPDATE invites SET game_id = NULL WHERE game_id IN ${target}`;
  const del = await tx`DELETE FROM games WHERE home_id = ${home} AND status = 'closed' AND number <= ${through} RETURNING id`;
  console.log(`Deleted ${del.length} games.`);
}

async function renumber(tx: Sql, home: string, tailFrom: number, tailTo: number) {
  const [h] = await tx<{ currency: string | null }[]>`SELECT currency FROM homes WHERE id = ${home}`;
  if (!h) throw new Error("home not found");
  const games = await tx<{ id: string; number: number; closed_at: Date }[]>`
    SELECT id, number, closed_at FROM games WHERE home_id = ${home} AND status = 'closed'`;
  const entries = await tx<{ game_id: string; player_id: string; total_in: string; cash_out: string }[]>`
    SELECT e.game_id, e.player_id, e.total_in::text, e.cash_out::text FROM game_entries e
    JOIN games g ON g.id = e.game_id WHERE g.home_id = ${home} AND g.status = 'closed'`;
  const byGame = new Map<string, { playerId: string; totalIn: number; cashOut: number }[]>();
  for (const e of entries) {
    const l = byGame.get(e.game_id) ?? [];
    l.push({ playerId: e.player_id, totalIn: Number(e.total_in), cashOut: Number(e.cash_out) });
    byGame.set(e.game_id, l);
  }
  const inTail = (n: number) => n >= tailFrom && n <= tailTo;
  games.sort((a, b) => Number(inTail(a.number)) - Number(inTail(b.number)) || a.number - b.number);

  // Move out of the way first: (home_id, number) is unique.
  await tx`UPDATE games SET number = number + 1000000 WHERE home_id = ${home} AND status = 'closed'`;
  const links = [];
  let prev = GENESIS_HASH;
  let n = 0;
  for (const g of games) {
    n++;
    const game = { homeId: home, number: n, closedAt: g.closed_at.toISOString(), currency: h.currency, entries: byGame.get(g.id) ?? [] };
    const hash = await gameHash(prev, game);
    await tx`UPDATE games SET number = ${n}, prev_hash = ${prev}, hash = ${hash} WHERE id = ${g.id}`;
    links.push({ game, prevHash: prev, hash });
    console.log(`  old #${g.number} -> #${n}  ${g.closed_at.toISOString().slice(0, 10)}`);
    prev = hash;
  }
  const bad = await verifyChain(links);
  if (bad !== -1) throw new Error(`chain check failed at link ${bad}`);
  console.log(`Renumbered ${n} games; hash chain verifies.`);
}

async function main() {
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url) throw new Error("DATABASE_URL_ADMIN is not set");
  const cmd = process.argv[2];
  const home = need("home");
  if (!/^[0-9a-f-]{36}$/i.test(home)) throw new Error("--home must be the home's uuid");
  const apply = process.argv.includes("--apply");
  if (cmd === "delete") {
    const through = Number(need("through"));
    if (!Number.isInteger(through) || through < 1) throw new Error("--through must be a game number");
    await run(url, apply, (tx) => deleteGames(tx, home, through));
  } else if (cmd === "renumber") {
    const from = Number(need("tail-from"));
    const to = Number(need("tail-to"));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new Error("--tail-from/--tail-to must be integers");
    await run(url, apply, (tx) => renumber(tx, home, from, to));
  } else {
    throw new Error("usage: fix-history delete|renumber --home <uuid> ... [--apply]");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
