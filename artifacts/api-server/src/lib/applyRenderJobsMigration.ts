import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Idempotently creates the `render_jobs` ledger table and its index.
 *
 * Mirrors applyBillingMigration: the api-server boot runs this so a clean
 * environment has the table regardless of whether `drizzle-kit push` was run
 * manually. Without it, the render endpoint's `createRenderJob` INSERT — which
 * every render goes through — 500s on a DB that only had the *billing* columns
 * pushed. CREATE TABLE / CREATE INDEX IF NOT EXISTS makes it safe to re-run.
 *
 * The DDL mirrors the Drizzle schema in `lib/db/src/schema/render.ts` EXACTLY
 * (column names, types, defaults, the index). drizzle-kit push remains the
 * source of truth; this is the same belt-and-suspenders fallback billing uses.
 */
export async function applyRenderJobsMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS render_jobs (
        id               varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id       integer NOT NULL,
        user_id          text NOT NULL,
        backend          varchar DEFAULT 'inline' NOT NULL,
        external_id      varchar,
        status           varchar DEFAULT 'queued' NOT NULL,
        progress         integer DEFAULT 0 NOT NULL,
        cost_cents       integer,
        format           varchar,
        config           jsonb,
        output_path      text,
        error            text,
        cancel_requested boolean DEFAULT false NOT NULL,
        created_at       timestamptz DEFAULT now() NOT NULL,
        updated_at       timestamptz DEFAULT now() NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "IDX_render_jobs_project"
        ON render_jobs (project_id)
    `);
    // Backs countLambdaJobsSince (user_id = ? AND backend = ? AND created_at >= ?).
    await client.query(`
      CREATE INDEX IF NOT EXISTS "IDX_render_jobs_user_backend_created"
        ON render_jobs (user_id, backend, created_at)
    `);
    // Backs getActiveLambdaJobs / boot recovery (backend = ? AND status = ?).
    await client.query(`
      CREATE INDEX IF NOT EXISTS "IDX_render_jobs_backend_status"
        ON render_jobs (backend, status)
    `);

    // Self-heal referential integrity: add the cascade FKs the Drizzle schema
    // declares (render.ts), using Drizzle's EXACT constraint names so a later
    // `drizzle-kit push` treats them as already-present (no duplicate FK). On a DB
    // where this table was boot-created FK-free and then accumulated rows, a plain
    // `db push` to add these FKs fails on any orphan; we sweep orphans first
    // (their parent project/user is already gone — a cascade FK would have removed
    // them anyway), then ADD. Each branch only runs when its FK is missing, so on
    // a healthy DB this is a couple of cheap catalog lookups. Wrapped in its own
    // guard: a failure here logs a warning but never hard-fails boot — the ledger
    // works without the FK, so this is hardening, not a load-bearing step (keeps
    // the documented "a missing prod db push never crashes boot" property).
    try {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'render_jobs_project_id_projects_id_fk'
          ) THEN
            DELETE FROM render_jobs rj
             WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = rj.project_id);
            ALTER TABLE render_jobs
              ADD CONSTRAINT render_jobs_project_id_projects_id_fk
              FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'render_jobs_user_id_users_id_fk'
          ) THEN
            DELETE FROM render_jobs rj
             WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = rj.user_id);
            ALTER TABLE render_jobs
              ADD CONSTRAINT render_jobs_user_id_users_id_fk
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
          END IF;
        END $$;
      `);
    } catch (fkErr) {
      logger.warn(
        { err: fkErr },
        "render_jobs FK self-heal skipped (non-fatal — ledger works without it)",
      );
    }

    logger.info("Render-jobs migration applied (idempotent)");
  } catch (err) {
    logger.error({ err }, "Render-jobs migration failed");
    throw err;
  } finally {
    client.release();
  }
}
