import { and, eq, inArray } from "drizzle-orm";
import { db, projectsTable, renderJobsTable } from "@workspace/db";
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

  const queueOn = isQueueEnabled();

  // Lambda renders survive a restart (they run in AWS); the progress poller
  // reconciles them via getRenderProgress. Never reset a project/job whose
  // render is live on Lambda, or we'd kill a paid execution.
  const lambdaProjectIds = await activeLambdaProjectIds();

  let reset = 0;
  for (const { id } of stuck) {
    if (lambdaProjectIds.has(id)) continue;
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

  await recoverStuckRenderJobs(queueOn, lambdaProjectIds);
}

/**
 * Mirror the project reconcile for the render_jobs ledger: any job still
 * `queued` or `rendering` with no live queue entry is an orphan from a crashed
 * process → mark it `failed`. The `status IN (...)` guard on the UPDATE avoids
 * clobbering a job that finished between the SELECT and the UPDATE.
 */
async function recoverStuckRenderJobs(
  queueOn: boolean,
  lambdaProjectIds: Set<number>,
): Promise<void> {
  let stuck: { id: string; projectId: number }[];
  try {
    stuck = await db
      .select({ id: renderJobsTable.id, projectId: renderJobsTable.projectId })
      .from(renderJobsTable)
      .where(inArray(renderJobsTable.status, ["queued", "rendering"]));
  } catch (err) {
    logger.warn({ err }, "Stuck render-job recovery query failed");
    return;
  }

  if (stuck.length === 0) return;

  let reset = 0;
  for (const { id, projectId } of stuck) {
    if (lambdaProjectIds.has(projectId)) continue;
    if (queueOn && (await hasPendingJob(projectId))) continue;
    await db
      .update(renderJobsTable)
      .set({ status: "failed", error: "Render interrupted by a restart" })
      .where(
        and(
          eq(renderJobsTable.id, id),
          inArray(renderJobsTable.status, ["queued", "rendering"]),
        ),
      );
    reset++;
  }

  if (reset > 0) logger.info({ reset }, "Reset stuck render jobs to failed");
}

/** Project ids with a render running on Lambda — the poller owns their lifecycle. */
async function activeLambdaProjectIds(): Promise<Set<number>> {
  try {
    const live = await db
      .select({ projectId: renderJobsTable.projectId })
      .from(renderJobsTable)
      .where(
        and(
          eq(renderJobsTable.backend, "lambda"),
          eq(renderJobsTable.status, "rendering"),
        ),
      );
    return new Set(live.map((r) => r.projectId));
  } catch (err) {
    logger.warn({ err }, "Active-lambda-jobs query failed");
    return new Set();
  }
}
