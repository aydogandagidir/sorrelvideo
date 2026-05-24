import { and, eq } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { logger } from "./logger";
import { hasPendingJob, isQueueEnabled } from "./renderQueue";

/**
 * Reconcile projects left in "rendering" after a restart.
 *
 * - Inline mode (no Redis): every "rendering" row is an orphan (its background
 *   render died with the process) → reset to "failed".
 * - Queue mode: if a job for the project is still waiting/active/delayed, the
 *   worker will resume it — leave it. Otherwise the job was lost → reset.
 *
 * The `AND status = 'rendering'` guard on the reset avoids clobbering a project
 * that legitimately moved to ready/failed between the SELECT and the UPDATE.
 */
export async function recoverStuckRenders(): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  let stuck: { id: number }[];
  try {
    stuck = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.status, "rendering"));
  } catch (err) {
    logger.warn({ err }, "Stuck-render recovery query failed");
    return;
  }

  if (stuck.length === 0) return;

  const queueOn = isQueueEnabled();
  let reset = 0;
  for (const { id } of stuck) {
    if (queueOn && (await hasPendingJob(id))) continue;
    await db
      .update(projectsTable)
      .set({ status: "failed", renderError: "Render interrupted by a restart" })
      .where(
        and(eq(projectsTable.id, id), eq(projectsTable.status, "rendering")),
      );
    reset++;
  }

  if (reset > 0) logger.info({ reset }, "Reset stuck renders to failed");
}
