import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Idempotently adds billing columns to the users table.
 * Safe to run on every startup — uses ADD COLUMN IF NOT EXISTS.
 * This ensures any environment (dev, staging, prod) has the schema
 * regardless of whether drizzle-kit push was run manually.
 */
export async function applyBillingMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS plan              varchar DEFAULT 'free' NOT NULL,
        ADD COLUMN IF NOT EXISTS stripe_customer_id varchar,
        ADD COLUMN IF NOT EXISTS stripe_subscription_id varchar,
        ADD COLUMN IF NOT EXISTS render_count      integer DEFAULT 0 NOT NULL,
        ADD COLUMN IF NOT EXISTS render_reset_at   timestamptz,
        ADD COLUMN IF NOT EXISTS ai_count          integer DEFAULT 0 NOT NULL,
        ADD COLUMN IF NOT EXISTS ai_reset_at       timestamptz,
        ADD COLUMN IF NOT EXISTS distributed_render_count integer DEFAULT 0 NOT NULL,
        ADD COLUMN IF NOT EXISTS distributed_render_reset_at timestamptz
    `);
    await client.query(`
      ALTER TABLE brand_kit
        ADD COLUMN IF NOT EXISTS brand_voice       text,
        ADD COLUMN IF NOT EXISTS voice_description text
    `);
    // Webhook ordering robustness (see webhookHandlers.ts): event_ts is the
    // monotonicity watermark, deleted_at the terminal tombstone marker. Both
    // mirror lib/db/src/schema/billing.ts. drizzle-kit push stays the source of
    // truth; these guards make a missed push non-fatal in any environment.
    await client.query(`
      ALTER TABLE stripe_subscriptions
        ADD COLUMN IF NOT EXISTS event_ts   timestamptz,
        ADD COLUMN IF NOT EXISTS deleted_at timestamptz
    `);
    // Idempotency ledger for processed webhook events (Stripe is at-least-once
    // and retries for up to 3 days). Mirrors processedStripeEventsTable.
    await client.query(`
      CREATE TABLE IF NOT EXISTS processed_stripe_events (
        id           varchar PRIMARY KEY,
        processed_at timestamptz DEFAULT now() NOT NULL
      )
    `);
    logger.info("Billing migration applied (idempotent)");
  } catch (err) {
    logger.error({ err }, "Billing migration failed");
    throw err;
  } finally {
    client.release();
  }
}
