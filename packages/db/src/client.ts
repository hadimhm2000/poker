import { drizzle } from "drizzle-orm/postgres-js";
import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Sql = ReturnType<typeof postgres>;

export function createDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { client, db };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` as the given user. Every query inside is limited by Row Level Security to what
 * that user may see and change. Always use this for request handling; never query as the
 * owner role from a request.
 */
export async function asUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error("invalid user id");
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SET LOCAL ROLE app_user`);
    await tx.execute(dsql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/** Sign-in code only: may read users and sessions, nothing else. */
export async function asAuth<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SET LOCAL ROLE app_auth`);
    return fn(tx);
  });
}
