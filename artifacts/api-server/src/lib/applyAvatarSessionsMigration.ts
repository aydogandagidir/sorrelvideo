import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Idempotently creates the `avatar_sessions` ledger table + its index (Track F).
 *
 * Mirrors applyRenderJobsMigration: the api-server boot runs this so a clean
 * environment has the table regardless of whether `drizzle-kit push` was run.
 * Without it, recording a LiveAvatar session would 500 on a DB that lacks the
 * table. CREATE TABLE / CREATE INDEX IF NOT EXISTS makes it safe to re-run.
 *
 * The DDL mirrors the Drizzle schema in `lib/db/src/schema/avatar.ts`; it is
 * deliberately FK-free so a missing `db push` never hard-fails boot (the FK is
 * applied by drizzle-kit push, the source of truth).
 */
export async function applyAvatarSessionsMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS avatar_sessions (
        id          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     text NOT NULL,
        session_id  varchar,
        sandbox     boolean DEFAULT true NOT NULL,
        created_at  timestamptz DEFAULT now() NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "IDX_avatar_sessions_user"
        ON avatar_sessions (user_id, created_at)
    `);
    logger.info("Avatar-sessions migration applied (idempotent)");
  } catch (err) {
    logger.error({ err }, "Avatar-sessions migration failed");
    throw err;
  } finally {
    client.release();
  }
}
