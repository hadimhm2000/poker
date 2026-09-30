import { asUser, schema } from "@poker/db";
import { eq, inArray } from "@poker/db";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** "Download my data": everything tied to the signed-in account, as JSON (GDPR access). */
export async function GET() {
  const user = await currentUser();
  if (!user || user.needsTwoFactor) return new Response(null, { status: 401 });
  const data = await asUser(getDb(), user.id, async (tx) => {
    const [me] = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        emailVerifiedAt: schema.users.emailVerifiedAt,
        displayName: schema.users.displayName,
        locale: schema.users.locale,
        plan: schema.users.plan,
        settings: schema.users.settings,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    const logins = await tx
      .select({ provider: schema.userIdentities.provider, email: schema.userIdentities.email, createdAt: schema.userIdentities.createdAt })
      .from(schema.userIdentities)
      .where(eq(schema.userIdentities.userId, user.id));
    const memberships = await tx
      .select({ home: schema.homes.name, role: schema.homeMembers.role, joinedAt: schema.homeMembers.joinedAt })
      .from(schema.homeMembers)
      .innerJoin(schema.homes, eq(schema.homes.id, schema.homeMembers.homeId))
      .where(eq(schema.homeMembers.userId, user.id));
    const players = await tx
      .select({ id: schema.players.id, home: schema.homes.name, name: schema.players.displayName })
      .from(schema.players)
      .innerJoin(schema.homes, eq(schema.homes.id, schema.players.homeId))
      .where(eq(schema.players.userId, user.id));
    const results = players.length
      ? await tx
          .select({
            playerId: schema.gameEntries.playerId,
            game: schema.games.number,
            closedAt: schema.games.closedAt,
            totalIn: schema.gameEntries.totalIn,
            cashOut: schema.gameEntries.cashOut,
          })
          .from(schema.gameEntries)
          .innerJoin(schema.games, eq(schema.games.id, schema.gameEntries.gameId))
          .where(inArray(schema.gameEntries.playerId, players.map((p) => p.id)))
      : [];
    const devices = await tx
      .select({ userAgent: schema.sessions.userAgent, lastSeenAt: schema.sessions.lastSeenAt, createdAt: schema.sessions.createdAt })
      .from(schema.sessions);
    return { exportedAt: new Date().toISOString(), account: me, logins, memberships, players, results, devices };
  });
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="poker-home-account.json"',
      "Cache-Control": "no-store",
    },
  });
}
