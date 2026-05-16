import {
  boolean,
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Local mirror of Stripe subscriptions, populated by webhook events
 * (customer.subscription.created/updated/deleted). Treated as the cached
 * source of truth for plan derivation — see services/billingService.ts.
 *
 * Never hand-edit; always upsert via webhook handlers so the cache stays
 * authoritative against Stripe.
 */
export const stripeSubscriptionsTable = pgTable(
  "stripe_subscriptions",
  {
    id: varchar("id").primaryKey(),
    customerId: varchar("customer_id").notNull(),
    status: varchar("status").notNull(),
    priceId: varchar("price_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    rawJson: jsonb("raw_json"),
  },
  (table) => [index("IDX_stripe_subscriptions_customer").on(table.customerId)],
);

export type StripeSubscription = typeof stripeSubscriptionsTable.$inferSelect;
export type NewStripeSubscription = typeof stripeSubscriptionsTable.$inferInsert;
