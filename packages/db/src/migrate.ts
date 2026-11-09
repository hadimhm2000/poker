import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Apply pending SQL migrations in order. Each file runs in its own transaction. */
export async function migrate(url: string): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const applied: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(dir, file), "utf8"));
        await tx`INSERT INTO schema_migrations(name) VALUES (${file})`;
      });
      applied.push(file);
    }
    return applied;
  } finally {
    await sql.end();
  }
}

// pathToFileURL: on Windows, process.argv[1] is "C:\...\migrate.ts" while import.meta.url is
// "file:///C:/.../migrate.ts" — a plain `file://${argv}` never matches there, so the script
// silently did nothing. pathToFileURL builds the same shape on every platform.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_ADMIN is not set");
  migrate(url).then((a) => console.log(a.length ? `applied: ${a.join(", ")}` : "up to date"));
}
