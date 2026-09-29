// Drizzle mirror of migrations/*.sql. The SQL files are the source of truth (they carry
// RLS, triggers and grants that Drizzle cannot express); keep this file in step with them.
import {
  bigint,
  bigserial,
  boolean,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const money = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const planEnum = pgEnum("plan", ["free", "pro"]);
export const memberRole = pgEnum("member_role", ["owner", "member"]);
export const gameStatus = pgEnum("game_status", ["draft", "live", "closed"]);
export const gameEventType = pgEnum("game_event_type", [
  "buy_in",
  "rebuy",
  "cash_out",
  "request",
  "approve",
  "reject",
  "confirm",
  "ruling",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique(),
  emailVerifiedAt: ts("email_verified_at"),
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull().default(""),
  locale: text("locale").notNull().default("en"),
  telegramId: bigint("telegram_id", { mode: "number" }).unique(),
  totpSecretEnc: bytea("totp_secret_enc"),
  totpEnabledAt: ts("totp_enabled_at"),
  plan: planEnum("plan").notNull().default("free"),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  tokenHash: bytea("token_hash").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  twoFactorPassed: boolean("two_factor_passed").notNull().default(false),
  ipHash: bytea("ip_hash"),
  userAgent: text("user_agent"),
});

export const homes = pgTable("homes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull(),
  name: text("name").notNull(),
  currency: text("currency"),
  unitSuffix: text("unit_suffix").notNull().default(""),
  unitDivisor: integer("unit_divisor").notNull().default(1),
  locale: text("locale").notNull().default("en"),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
  requireConfirmation: boolean("require_confirmation").notNull().default(false),
  settings: jsonb("settings").notNull().default({}),
  readOnly: boolean("read_only").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey().defaultRandom(),
  homeId: uuid("home_id").notNull(),
  displayName: text("display_name").notNull(),
  userId: uuid("user_id"),
  avatar: text("avatar"),
  paymentInfoEnc: bytea("payment_info_enc"),
  mergedInto: uuid("merged_into"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const homeMembers = pgTable(
  "home_members",
  {
    homeId: uuid("home_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: memberRole("role").notNull(),
    playerId: uuid("player_id"),
    joinedAt: ts("joined_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.homeId, t.userId] })],
);

export const games = pgTable("games", {
  id: uuid("id").primaryKey().defaultRandom(),
  homeId: uuid("home_id").notNull(),
  number: integer("number"),
  status: gameStatus("status").notNull().default("draft"),
  defaultBuyIn: money("default_buy_in").notNull().default(0),
  startedAt: ts("started_at"),
  closedAt: ts("closed_at"),
  version: integer("version").notNull().default(1),
  closeKey: uuid("close_key"),
  hash: text("hash"),
  prevHash: text("prev_hash"),
  createdBy: uuid("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const gameEntries = pgTable(
  "game_entries",
  {
    gameId: uuid("game_id").notNull(),
    playerId: uuid("player_id").notNull(),
    totalIn: money("total_in").notNull().default(0),
    cashOut: money("cash_out"),
    confirmedAt: ts("confirmed_at"),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.playerId] })],
);

export const gameEvents = pgTable("game_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull(),
  type: gameEventType("type").notNull(),
  playerId: uuid("player_id"),
  amount: money("amount"),
  requestId: uuid("request_id"),
  details: jsonb("details"),
  actorId: uuid("actor_id").notNull(),
  at: ts("at").notNull().defaultNow(),
});

export const settlements = pgTable("settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull(),
  fromPlayer: uuid("from_player").notNull(),
  toPlayer: uuid("to_player").notNull(),
  amount: money("amount").notNull(),
});

export const debtPayments = pgTable("debt_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  settlementId: uuid("settlement_id").notNull().unique(),
  kind: text("kind", { enum: ["paid", "carried"] }).notNull().default("paid"),
  carriedToGame: uuid("carried_to_game"),
  markedBy: uuid("marked_by").notNull(),
  markedAt: ts("marked_at").notNull().defaultNow(),
});

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  homeId: uuid("home_id").notNull(),
  tokenHash: bytea("token_hash").notNull().unique(),
  playerId: uuid("player_id"),
  expiresAt: ts("expires_at").notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  uses: integer("uses").notNull().default(0),
  revokedAt: ts("revoked_at"),
  createdBy: uuid("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  provider: text("provider").notNull(),
  providerRef: text("provider_ref").notNull(),
  status: text("status").notNull(),
  currentPeriodEnd: ts("current_period_end"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  targetTable: text("target_table").notNull(),
  targetId: text("target_id"),
  homeId: uuid("home_id"),
  details: jsonb("details"),
  ipHash: bytea("ip_hash"),
  at: ts("at").notNull().defaultNow(),
});
