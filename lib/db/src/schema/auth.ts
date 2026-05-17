import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

export const usersTable = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  // Argon2id hash. Null for users created via OAuth (future) — at least one
  // credential (password or OAuth identity) must exist for sign-in.
  passwordHash: varchar("password_hash"),
  // Null = unverified. Set when /api/auth/verify-email is consumed.
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  // Billing. stripeCustomerId is written on first checkout.
  // plan and stripeSubscriptionId are reserved columns; current plan is
  // derived at runtime by querying the local stripe_subscriptions cache
  // (synced from Stripe webhooks). Never treat these columns as the source of truth.
  plan: varchar("plan", { enum: ["free", "pro"] })
    .notNull()
    .default("free"),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  renderCount: integer("render_count").notNull().default(0),
  renderResetAt: timestamp("render_reset_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;

/**
 * Email verification tokens. Issued on signup (or via /resend-verification),
 * single-use; the token itself never lands in DB — only its HMAC-SHA256 hash
 * does, so a DB leak does not let an attacker verify accounts.
 */
export const emailVerificationsTable = pgTable(
  "email_verifications",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("IDX_email_verifications_user").on(table.userId),
    index("IDX_email_verifications_token").on(table.tokenHash),
  ],
);

/**
 * Password reset tokens. Same hash-only storage as email verifications;
 * `usedAt` marks consumption so a single token can't be replayed.
 */
export const passwordResetsTable = pgTable(
  "password_resets",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("IDX_password_resets_user").on(table.userId),
    index("IDX_password_resets_token").on(table.tokenHash),
  ],
);

/**
 * Links external OAuth identities (GitHub / Google) to a Sorrel user.
 * UNIQUE(provider, providerAccountId) — one row per identity. A single
 * user may have multiple rows (one per provider).
 *
 * No access/refresh tokens are stored: we only need the identity for
 * sign-in, not provider-side API access. Add a token column later if a
 * feature ever needs to call the provider on the user's behalf.
 */
export const oauthAccountsTable = pgTable(
  "oauth_accounts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    provider: varchar("provider", { enum: ["github", "google"] }).notNull(),
    providerAccountId: varchar("provider_account_id").notNull(),
    providerEmail: varchar("provider_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("UQ_oauth_accounts_provider_account").on(
      table.provider,
      table.providerAccountId,
    ),
    index("IDX_oauth_accounts_user").on(table.userId),
  ],
);
