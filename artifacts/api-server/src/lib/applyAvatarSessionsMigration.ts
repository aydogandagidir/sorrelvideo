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

    // Self-heal referential integrity: add the cascade FK the Drizzle schema
    // declares (avatar.ts userId → users.id), using Drizzle's exact constraint
    // name so a later `drizzle-kit push` treats it as already-present. Sweep
    // orphans first so ADD CONSTRAINT can't fail on a boot-before-push DB that
    // accumulated FK-free rows. Only runs when the FK is missing, and is wrapped
    // so a failure logs a warning but never hard-fails boot (the table works
    // without the FK — hardening, not load-bearing). See applyRenderJobsMigration.
    try {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'avatar_sessions_user_id_users_id_fk'
          ) THEN
            DELETE FROM avatar_sessions a
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id);
            ALTER TABLE avatar_sessions
              ADD CONSTRAINT avatar_sessions_user_id_users_id_fk
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
          END IF;
        END $$;
      `);
    } catch (fkErr) {
      logger.warn(
        { err: fkErr },
        "avatar_sessions FK self-heal skipped (non-fatal — table works without it)",
      );
    }

    logger.info("Avatar-sessions migration applied (idempotent)");
  } catch (err) {
    logger.error({ err }, "Avatar-sessions migration failed");
    throw err;
  } finally {
    client.release();
  }
}
