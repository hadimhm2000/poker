// Limited site admin for support (sign-in role). Who counts as an admin is decided by the
// app; every function here writes to the append-only audit log in the database.
import { sql } from "drizzle-orm";
import type { Tx } from "./client";

export interface AdminOverview {
  users: number;
  usersNew30d: number;
  pro: number;
  homes: number;
  gamesClosed: number;
  gamesClosed30d: number;
  twoFactor: number;
  telegram: number;
}

export async function adminOverview(tx: Tx, actor: string): Promise<AdminOverview> {
  const [r] = await tx.execute<{ o: Record<string, string | number> }>(sql`SELECT app.admin_overview(${actor}) AS o`);
  return Object.fromEntries(Object.entries(r!.o).map(([k, v]) => [k, Number(v)])) as unknown as AdminOverview;
}

export interface AdminUserRow {
  id: string;
  email: string | null;
  display_name: string;
  created_at: string;
  plan: string;
  two_factor: boolean;
  telegram: boolean;
  homes_owned: number;
  memberships: number;
  deleted: boolean;
}

export async function adminFindUsers(tx: Tx, actor: string, q: string): Promise<AdminUserRow[]> {
  return [...(await tx.execute<AdminUserRow>(sql`SELECT * FROM app.admin_find_users(${actor}, ${q.trim().slice(0, 254)})`))];
}

export async function adminSetPlan(tx: Tx, actor: string, userId: string, plan: "free" | "pro", reason: string) {
  await tx.execute(sql`SELECT app.admin_set_plan(${actor}, ${userId}, ${plan}, ${reason.trim()})`);
}

export async function adminEndSessions(tx: Tx, actor: string, userId: string, reason: string): Promise<number> {
  const [r] = await tx.execute<{ n: number }>(sql`SELECT app.admin_end_sessions(${actor}, ${userId}, ${reason.trim()}) AS n`);
  return Number(r!.n);
}

/** Open one home's history for an hour, for a support request. */
export async function adminOpenHome(tx: Tx, actor: string, homeId: string, reason: string): Promise<Date> {
  const [r] = await tx.execute<{ until: string }>(sql`SELECT app.admin_open_home(${actor}, ${homeId}, ${reason.trim()}) AS until`);
  return new Date(r!.until);
}

export interface AdminHomeView {
  id: string;
  name: string;
  createdAt: string;
  deletedAt: string | null;
  until: string;
  owner: string | null;
  members: number;
  players: number;
  games: {
    number: number | null;
    status: string;
    closedAt: string | null;
    hash: string | null;
    entries: { player: string; in: number; out: number | null }[];
  }[];
}

export async function adminViewHome(tx: Tx, actor: string, homeId: string): Promise<AdminHomeView> {
  const [r] = await tx.execute<{ v: AdminHomeView }>(sql`SELECT app.admin_view_home(${actor}, ${homeId}) AS v`);
  return r!.v;
}

export interface AdminLogRow {
  at: string;
  actor_email: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export async function adminRecent(tx: Tx, actor: string, n = 50): Promise<AdminLogRow[]> {
  return [...(await tx.execute<AdminLogRow>(sql`SELECT * FROM app.admin_recent(${actor}, ${n})`))];
}
