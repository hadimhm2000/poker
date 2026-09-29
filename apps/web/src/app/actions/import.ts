"use server";

import { eq, homePlan, importGame, resultRows, schema } from "@poker/db";
import { z } from "zod";
import type { ParsedGame } from "@/lib/import-parse";
import { readUpload } from "@/lib/import-read";
import { withUser } from "@/lib/session";

export type PreviewState =
  | { stage: "idle" }
  | { stage: "error"; code: "noColumns" | "tooBig" | "PRO" | "FORBIDDEN" | "ERROR" }
  | { stage: "preview"; games: ParsedGame[]; columns: string[]; sheet?: string }
  | { stage: "done"; count: number };

const MAX_BYTES = 2 * 1024 * 1024;

async function checkAccess(homeId: string) {
  return withUser(async (tx, user) => {
    const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, homeId));
    if (!home || home.ownerId !== user.id || home.readOnly) return { ok: false as const, code: "FORBIDDEN" as const };
    if ((await homePlan(tx, homeId)) !== "pro") return { ok: false as const, code: "PRO" as const };
    const rows = await resultRows(tx, homeId);
    const byGame = new Map<string, { date: string; results: { name: string; net: number }[] }>();
    for (const r of rows) {
      const g = byGame.get(r.gameId) ?? { date: r.closedAt.toISOString().slice(0, 10), results: [] };
      g.results.push({ name: r.name, net: r.cashOut - r.totalIn });
      byGame.set(r.gameId, g);
    }
    return { ok: true as const, home, existing: [...byGame.values()] };
  });
}

export async function previewImportAction(_prev: PreviewState, form: FormData): Promise<PreviewState> {
  const homeId = z.string().uuid().parse(form.get("homeId"));
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { stage: "error", code: "noColumns" };
  if (file.size > MAX_BYTES) return { stage: "error", code: "tooBig" };
  const access = await checkAccess(homeId);
  if (!access.ok) return { stage: "error", code: access.code };
  try {
    const r = await readUpload(file, access.home.unitDivisor, access.existing);
    if (r.error) return { stage: "error", code: r.error };
    return { stage: "preview", games: r.games, columns: Object.values(r.columns), sheet: r.sheet };
  } catch {
    return { stage: "error", code: "noColumns" };
  }
}

const gamesInput = z
  .array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      rows: z.array(z.object({ name: z.string().trim().min(1).max(40), totalIn: z.number().int().nonnegative(), cashOut: z.number().int().nonnegative() })).min(2).max(40),
    }),
  )
  .min(1)
  .max(2000);

export async function confirmImportAction(_prev: PreviewState, form: FormData): Promise<PreviewState> {
  const homeId = z.string().uuid().parse(form.get("homeId"));
  const parsed = gamesInput.safeParse(JSON.parse(String(form.get("games") ?? "[]")));
  if (!parsed.success) return { stage: "error", code: "ERROR" };
  const access = await checkAccess(homeId);
  if (!access.ok) return { stage: "error", code: access.code };
  try {
    // All or nothing: one transaction, each game through the normal close path.
    const count = await withUser(async (tx, user) => {
      for (const g of parsed.data) {
        await importGame(tx, user.id, { homeId, playedAt: `${g.date}T20:00:00Z`, rows: g.rows });
      }
      return parsed.data.length;
    });
    return { stage: "done", count };
  } catch {
    return { stage: "error", code: "ERROR" };
  }
}
