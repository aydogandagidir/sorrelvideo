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
    /**
     * Logical timestamp of the most recent webhook event applied to this row
     * (the originating `event.created`). Used for monotonicity: Stripe neither
     * guarantees delivery order nor exactly-once (it retries for up to 3 days),
     * so a write whose event is OLDER than what we already applied is skipped —
     * otherwise a late `updated(active)` could revive a canceled sub, or a late
     * `deleted` could revoke a paying one. Null on legacy rows → first write wins.
     */
    eventTs: timestamp("event_ts", { withTimezone: true }),
    /**
     * Set when a `customer.subscription.deleted` tombstones this row (status is
     * also flipped to 'canceled'). A non-null value is TERMINAL: a subsequently
     * delivered (but logically older) `updated` event must NOT resurrect the
     * subscription. Stripe never reuses a deleted subscription id — resubscribing
     * mints a new one — so reviving this id is always wrong.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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

/**
 * Idempotency ledger for processed Stripe webhook events. Stripe may deliver
 * the same event id more than once (at-least-once delivery + up to 3 days of
 * retries); recording each handled `event.id` lets `processWebhook` no-op a
 * replay instead of re-applying it. One row per event, PK on the event id.
 *
 * Never hand-edit; rows are written by the webhook handler after a successful
 * dispatch.
 */
export const processedStripeEventsTable = pgTable("processed_stripe_events", {
  id: varchar("id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProcessedStripeEvent =
  typeof processedStripeEventsTable.$inferSelect;
export type NewProcessedStripeEvent =
  typeof processedStripeEventsTable.$inferInsert;
