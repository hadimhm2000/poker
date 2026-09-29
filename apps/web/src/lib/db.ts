import "server-only";
import { createDb } from "@poker/db";

// One pool per server process. DATABASE_URL is a login role that is a member of app_user and
// app_auth (see README); it must not be a superuser or the table owner.
const globalForDb = globalThis as unknown as { pokerDb?: ReturnType<typeof createDb> };

export function getDb() {
  if (!globalForDb.pokerDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.pokerDb = createDb(url);
  }
  return globalForDb.pokerDb.db;
}
