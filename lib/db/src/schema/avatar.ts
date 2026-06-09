import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

/**
 * Avatar session ledger (Track F — billing foundation). One row per LiveAvatar
 * session START (recorded when a token is minted). This is the usage base for
 * future per-minute billing; `duration`/`cost` columns are a deliberate additive
 * follow-up once the metering signal (a stop endpoint / HeyGen webhook) AND the
 * pricing model are decided. Every row is userId-scoped like the rest of the
 * schema; the service layer enforces ownership.
 *
 * Like render_jobs, the boot migration (applyAvatarSessionsMigration) creates
 * this FK-free so a missing prod `db push` never hard-fails boot; the FK below is
 * applied by `drizzle-kit push` (the source of truth).
 */
export const avatarSessionsTable = pgTable(
  "avatar_sessions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** LiveAvatar's own session id (from the token mint), when present. */
    sessionId: varchar("session_id"),
    /** Whether the session ran in sandbox mode (no credit consumption). */
    sandbox: boolean("sandbox").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("IDX_avatar_sessions_user").on(table.userId, table.createdAt),
  ],
);

export type AvatarSessionRow = typeof avatarSessionsTable.$inferSelect;
export type NewAvatarSessionRow = typeof avatarSessionsTable.$inferInsert;
