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
        ADD COLUMN IF NOT EXISTS render_reset_at   timestamptz
    `);
    logger.info("Billing migration applied (idempotent)");
  } catch (err) {
    logger.error({ err }, "Billing migration failed");
    throw err;
  } finally {
    client.release();
  }
}
