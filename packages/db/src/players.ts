import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "./client";
import { DomainError } from "./repo";
import { homeMembers, invites, players } from "./schema";

// Home and player modules: member list and removal, home invite links, avatars, payment
// details and merging duplicate players. Same rule as repo.ts: run inside asUser().

const id = z.string().uuid();

// ---------------------------------------------------------------- members

export interface MemberRow {
  userId: string;
  name: string;
  role: "owner" | "member";
  joinedAt: Date;
  playerId: string | null;
}

/** Members of a home with a display name (never an email). Empty for non-members. */
export async function memberList(tx: Tx, homeId: string): Promise<MemberRow[]> {
  const rows = await tx.execute<{ user_id: string; name: string; role: "owner" | "member"; joined_at: string | Date; player_id: string | null }>(
    sql`SELECT * FROM app.home_member_list(${id.parse(homeId)})`,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    role: r.role,
    joinedAt: new Date(r.joined_at),
    playerId: r.player_id,
  }));
}

/** Host removes a member. The host's own row can never be removed (members_remove policy). */
export async function removeMember(tx: Tx, homeId: string, userId: string) {
  const gone = await tx
    .delete(homeMembers)
    .where(and(eq(homeMembers.homeId, id.parse(homeId)), eq(homeMembers.userId, id.parse(userId)), eq(homeMembers.role, "member")))
    .returning({ userId: homeMembers.userId });
  if (!gone.length) throw new DomainError("NOT_FOUND");
}

// ---------------------------------------------------------------- invites

export const homeInviteInput = z.object({
  homeId: id,
  playerId: id.nullable().default(null),
  maxUses: z.number().int().min(1).max(50).default(1),
  days: z.number().int().min(1).max(30).default(7),
});

/**
 * A home invite link. The token is derived from the invite id by the caller (`hashFor` returns
 * sha256 of that token), so only the hash is stored and the host's page can redraw link and QR.
 */
export async function createHomeInvite(
  tx: Tx,
  userId: string,
  input: z.input<typeof homeInviteInput>,
  hashFor: (inviteId: string) => Buffer,
) {
  const v = homeInviteInput.parse(input);
  if (v.playerId) {
    const [p] = await tx.select().from(players).where(and(eq(players.id, v.playerId), eq(players.homeId, v.homeId)));
    if (!p || p.userId || p.mergedInto) throw new DomainError("INVALID");
  }
  const inviteId = crypto.randomUUID();
  await tx.insert(invites).values({
    id: inviteId,
    homeId: v.homeId,
    playerId: v.playerId,
    tokenHash: hashFor(inviteId),
    maxUses: v.maxUses,
    expiresAt: new Date(Date.now() + v.days * 864e5),
    createdBy: userId,
  });
  return inviteId;
}

/** The home's usable invite links (not game join links), newest first. Host only (RLS). */
export async function activeInvites(tx: Tx, homeId: string) {
  return tx
    .select({
      id: invites.id,
      tokenHash: invites.tokenHash,
      playerId: invites.playerId,
      expiresAt: invites.expiresAt,
      uses: invites.uses,
      maxUses: invites.maxUses,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .where(
      and(
        eq(invites.homeId, id.parse(homeId)),
        isNull(invites.gameId),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, sql`now()`),
        sql`${invites.uses} < ${invites.maxUses}`,
      ),
    )
    .orderBy(desc(invites.createdAt));
}

export async function revokeInvite(tx: Tx, homeId: string, inviteId: string) {
  const done = await tx
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, id.parse(inviteId)), eq(invites.homeId, id.parse(homeId)), isNull(invites.revokedAt)))
    .returning({ id: invites.id });
  if (!done.length) throw new DomainError("NOT_FOUND");
}

// ---------------------------------------------------------------- avatars and payment details

/** The avatars a player can pick. The database CHECK constraint holds the same list. */
export const AVATARS = [
  "🦊", "🐻", "🐼", "🦁", "🐯", "🐸", "🐵", "🦉", "🦈", "🐙", "🐺", "🦄",
  "🐲", "🤠", "😎", "🤖", "👑", "🎩", "🍀", "🔥", "💎", "🃏", "🎲", "🚀",
] as const;
export type Avatar = (typeof AVATARS)[number];
export const avatarInput = z.enum(AVATARS).nullable();

/** The host, or the player's own linked user. */
export async function setAvatar(tx: Tx, playerId: string, avatar: string | null) {
  const a = avatarInput.parse(avatar);
  await tx.execute(sql`SELECT app.set_player_avatar(${id.parse(playerId)}, ${a})`);
}

/** Plain payment details as typed: card number, IBAN or PayPal address, one short note. */
export const paymentInfoInput = z
  .string()
  .transform((s) => s.replace(/\r\n/g, "\n").trim())
  .pipe(z.string().max(200));

/**
 * Store payment details already encrypted by the caller (AES-256-GCM, key outside the
 * database); null clears them. The host, or the player's own linked user.
 */
export async function setPaymentInfo(tx: Tx, playerId: string, encrypted: Buffer | null) {
  if (encrypted && encrypted.length > 1024) throw new DomainError("INVALID");
  await tx.execute(sql`SELECT app.set_player_payment(${id.parse(playerId)}, ${encrypted})`);
}

// ---------------------------------------------------------------- merging duplicates

/**
 * Merge `duplicateId` into `keepId` (host only). The duplicate's rows in open games move to
 * the kept player; closed games stay as they are and statistics map them when reading.
 * Refused when both sit in the same open game or both are linked to accounts.
 */
export async function mergePlayers(tx: Tx, keepId: string, duplicateId: string) {
  const keep = id.parse(keepId);
  const dup = id.parse(duplicateId);
  if (keep === dup) throw new DomainError("INVALID");
  await tx.execute(sql`SELECT app.merge_players(${keep}, ${dup})`);
}
