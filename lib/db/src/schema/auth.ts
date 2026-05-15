import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const usersTable = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  // Billing — plan is derived at runtime from stripe.subscriptions (via stripe-replit-sync)
  // but stored here as a cache for fast reads; updated by webhooks.
  plan: varchar("plan", { enum: ["free", "pro"] }).notNull().default("free"),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  renderCount: integer("render_count").notNull().default(0),
  renderResetAt: timestamp("render_reset_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;
