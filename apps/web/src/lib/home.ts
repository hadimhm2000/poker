import "server-only";
import { type Tx, eq, resultRows, schema } from "@poker/db";

/** The home (if visible to this user) and all its closed-game rows. */
export async function loadHomeResults(tx: Tx, homeId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(homeId)) return null;
  const [home] = await tx.select().from(schema.homes).where(eq(schema.homes.id, homeId));
  if (!home) return null;
  return { home, rows: await resultRows(tx, homeId) };
}

/**
 * Stable chart slot per player: order of first appearance in the home's history.
 * Colour follows the player, never their rank, so it never changes between views.
 */
export function playerSlots(rows: { playerId: string }[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const r of rows) if (!slots.has(r.playerId)) slots.set(r.playerId, slots.size);
  return slots;
}
