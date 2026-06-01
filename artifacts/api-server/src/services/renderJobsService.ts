/**
 * Render-job ledger service — userId-scoped CRUD over `render_jobs`.
 *
 * The render pipeline (renderService + renderQueue) writes one row per render
 * attempt and advances it through queued → rendering → ready/failed/cancelled.
 * Routes own auth/HTTP; this module owns the persistence logic. Ownership-
 * sensitive operations (`createRenderJob`, `requestCancel`) take a `userId` and
 * scope on it; the lifecycle setters (`markRendering`/`markProgress`/…) are
 * called by the executor that already holds the job id it just created, so they
 * key on the job id alone.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  renderJobsTable,
  type RenderJobRow,
  type RenderSettings,
} from "@workspace/db";

/** Insert a queued render-job row and return its generated id. */
export async function createRenderJob(input: {
  projectId: number;
  userId: string;
  backend: "inline" | "bullmq" | "lambda";
  config: RenderSettings;
  format?: string;
}): Promise<string> {
  const [row] = await db
    .insert(renderJobsTable)
    .values({
      projectId: input.projectId,
      userId: input.userId,
      backend: input.backend,
      status: "queued",
      progress: 0,
      config: input.config,
      format: input.format ?? null,
    })
    .returning({ id: renderJobsTable.id });
  return row.id;
}

/** Flip a job to `rendering` (called when the executor picks it up). */
export async function markRendering(id: string): Promise<void> {
  await db
    .update(renderJobsTable)
    .set({ status: "rendering" })
    .where(eq(renderJobsTable.id, id));
}

/** Record progress as an integer percentage, clamped to 0–100. */
export async function markProgress(id: string, pct: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  await db
    .update(renderJobsTable)
    .set({ progress: clamped })
    .where(eq(renderJobsTable.id, id));
}

/** Mark a job `ready` and stamp progress to 100 plus optional artifact info. */
export async function markReady(
  id: string,
  extra?: { duration?: number; outputPath?: string },
): Promise<void> {
  await db
    .update(renderJobsTable)
    .set({
      status: "ready",
      progress: 100,
      ...(extra?.outputPath !== undefined
        ? { outputPath: extra.outputPath }
        : {}),
    })
    .where(eq(renderJobsTable.id, id));
}

/** Mark a job `failed` and store the error message. */
export async function markFailed(id: string, error: string): Promise<void> {
  await db
    .update(renderJobsTable)
    .set({ status: "failed", error })
    .where(eq(renderJobsTable.id, id));
}

/** Mark a job `cancelled` (the executor saw the cancel flag and stopped). */
export async function markCancelled(id: string): Promise<void> {
  await db
    .update(renderJobsTable)
    .set({ status: "cancelled" })
    .where(eq(renderJobsTable.id, id));
}

/** True if a caller has requested this job abort. */
export async function isCancelRequested(id: string): Promise<boolean> {
  const [row] = await db
    .select({ cancelRequested: renderJobsTable.cancelRequested })
    .from(renderJobsTable)
    .where(eq(renderJobsTable.id, id));
  return row?.cancelRequested ?? false;
}

/**
 * Request that a running job abort. Scoped to the owner: the update only
 * matches when both the job id AND userId line up, so a user can't cancel
 * another tenant's render. Returns true when a row was flagged.
 */
export async function requestCancel(
  id: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(renderJobsTable)
    .set({ cancelRequested: true })
    .where(and(eq(renderJobsTable.id, id), eq(renderJobsTable.userId, userId)))
    .returning({ id: renderJobsTable.id });
  return rows.length > 0;
}

/** Newest render job for a project, or undefined if none exist. */
export async function getLatestJobForProject(
  projectId: number,
): Promise<RenderJobRow | undefined> {
  const [row] = await db
    .select()
    .from(renderJobsTable)
    .where(eq(renderJobsTable.projectId, projectId))
    .orderBy(desc(renderJobsTable.createdAt))
    .limit(1);
  return row;
}
