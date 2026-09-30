import postgres from "postgres";
import { type Db, createDb } from "../src/client";
import { migrate } from "../src/migrate";

const base = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/postgres";

export interface TestDb {
  db: Db;
  /** Superuser connection: stands in for "someone with direct database access". */
  admin: ReturnType<typeof postgres>;
  /** Connection string of this test database (superuser). */
  url: string;
  newUser: (plan?: "free" | "pro") => Promise<string>;
  close: () => Promise<void>;
}

export async function freshDb(): Promise<TestDb> {
  const name = `poker_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(base);
  url.pathname = `/${name}`;
  await withClusterLock(async (root) => {
    await root.unsafe(`CREATE DATABASE ${name}`);
    await migrate(url.toString());
  });
  const { db, client } = createDb(url.toString(), { max: 20 });
  const admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
  let n = 0;
  return {
    db,
    admin,
    url: url.toString(),
    newUser: async (plan = "pro") => {
      const [u] = await admin`INSERT INTO users(email, plan) VALUES (${`u${++n}@test.local`}, ${plan}) RETURNING id`;
      return u!.id as string;
    },
    close: async () => {
      await client.end();
      await admin.end();
      const r = postgres(base, { max: 1, onnotice: () => {} });
      await r.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await r.end();
    },
  };
}

/** Postgres error text of a rejected promise (drizzle wraps the driver error in `cause`). */
export async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected the operation to fail");
}

/**
 * Roles are shared by the whole Postgres cluster, so test files that migrate their own
 * databases at the same time would race creating them. Migrate one at a time.
 */
export async function withClusterLock<T>(fn: (root: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const root = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await root`SELECT pg_advisory_lock(727274)`;
    return await fn(root);
  } finally {
    await root`SELECT pg_advisory_unlock(727274)`.catch(() => {});
    await root.end();
  }
}
