import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Idempotently migrates `brand_kit` from one-row-per-user to many-per-user, and
 * adds `projects.brand_kit_id`. Safe to run on every startup (ADD COLUMN /
 * DROP CONSTRAINT / CREATE INDEX … IF [NOT] EXISTS), so a fresh or
 * never-pushed environment self-heals — drizzle-kit push stays the source of
 * truth (see lib/db/src/schema/brand.ts), these guards just make a missed push
 * non-fatal.
 *
 * Order matters: add the columns, back-fill exactly one default per user, drop
 * the old single-kit UNIQUE, THEN create the partial-unique default index (so
 * the back-fill can't trip it).
 */
export async function applyBrandKitMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE brand_kit
        ADD COLUMN IF NOT EXISTS name       text    NOT NULL DEFAULT 'Brand kit',
        ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS source_url text
    `);

    // Projects can pin a specific kit; null falls back to the user's default.
    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS brand_kit_id integer
    `);

    // Back-fill: promote each user's earliest kit to the default when they have
    // none yet (true for every row migrated from the old one-kit-per-user world).
    // Runs BEFORE the partial-unique index exists so it can't conflict; once a
    // user has a default the NOT EXISTS guard makes re-runs a no-op.
    await client.query(`
      UPDATE brand_kit b
        SET is_default = true
      WHERE b.is_default = false
        AND NOT EXISTS (
          SELECT 1 FROM brand_kit d
          WHERE d.user_id = b.user_id AND d.is_default = true
        )
        AND b.id = (
          SELECT MIN(e.id) FROM brand_kit e WHERE e.user_id = b.user_id
        )
    `);

    // Drop the legacy one-kit-per-user UNIQUE so additional kits can be created.
    await client.query(`
      ALTER TABLE brand_kit DROP CONSTRAINT IF EXISTS "UQ_brand_kit_user"
    `);

    // At most one default per user; many non-defaults allowed.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_brand_kit_default"
        ON brand_kit (user_id) WHERE is_default
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "IDX_brand_kit_user" ON brand_kit (user_id)
    `);

    logger.info("Brand-kit migration applied (idempotent)");
  } catch (err) {
    logger.error({ err }, "Brand-kit migration failed");
    throw err;
  } finally {
    client.release();
  }
}
