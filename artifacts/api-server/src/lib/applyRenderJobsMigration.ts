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
    logger.info("Render-jobs migration applied (idempotent)");
  } catch (err) {
    logger.error({ err }, "Render-jobs migration failed");
    throw err;
  } finally {
    client.release();
  }
}
