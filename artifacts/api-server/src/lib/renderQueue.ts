import type { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "./logger";
import { executeRender } from "../services/renderService";
import { selectBackend } from "./renderBackend";
import {
  dispatchLambdaRender,
  LambdaDispatchError,
} from "./renderBackends/lambdaBackend";
import { resolveSettings } from "../services/renderSettingsService";
import { getJobById } from "../services/renderJobsService";
import { db, projectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Durable render queue (BullMQ + Redis) with a graceful inline fallback.
 *
 * Mirrors the no-op philosophy of lib/sentry.ts: when REDIS_URL is unset,
 * bullmq/ioredis are never imported and renders run inline (fire-and-forget),
 * exactly as before the queue existed. When REDIS_URL is set, renders are
 * enqueued and consumed by an in-process worker that survives restarts (jobs
 * persist in Redis).
 */

export interface RenderJobData {
  projectId: number;
  module: string;
  templateId: number | null;
  /** Ledger row id (render_jobs) this enqueue corresponds to. */
  renderJobId: string;
}

const QUEUE_NAME = "render";
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? "1") || 1;
const ATTEMPTS = Number(process.env.RENDER_JOB_ATTEMPTS ?? "1") || 1;

/**
 * Stable per-project job id used for dedup. Must NOT be a bare number —
 * BullMQ rejects purely-numeric custom job ids ("Custom Id cannot be integers"),
 * so we prefix it.
 */
function jobIdFor(projectId: number): string {
  return `render-${projectId}`;
}

let connection: Redis | null = null;
let queue: Queue<RenderJobData> | null = null;
let worker: Worker<RenderJobData> | null = null;

/** True when a Redis URL is configured — gates everything below. */
export function isQueueEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/** Lazily create the shared ioredis connection (BullMQ requires null retries). */
async function getConnection(): Promise<Redis> {
  if (connection) return connection;
  const { default: IORedis } = await import("ioredis");
  connection = new IORedis(process.env.REDIS_URL as string, {
    maxRetriesPerRequest: null,
  });
  connection.on("error", (err) =>
    logger.error({ err }, "Redis connection error"),
  );
  return connection;
}

/** Lazily create the render Queue singleton (producer side). */
export async function getRenderQueue(): Promise<Queue<RenderJobData>> {
  if (queue) return queue;
  const { Queue } = await import("bullmq");
  queue = new Queue<RenderJobData>(QUEUE_NAME, {
    connection: await getConnection(),
  });
  return queue;
}

/**
 * Resolve the userId + gated render settings for a Lambda dispatch. Reads the
 * ledger row first (its `config` is the exact snapshot the route gated, and it
 * carries `userId`); if the row is somehow missing, falls back to the project's
 * own `userId` + `renderSettings` columns. `resolveSettings` coerces either
 * source into a complete, valid `RenderSettings` (null → defaults).
 */
async function loadDispatchContext(
  projectId: number,
  renderJobId: string,
): Promise<{ userId: string; settings: ReturnType<typeof resolveSettings> }> {
  const job = await getJobById(renderJobId);
  if (job) {
    return {
      userId: job.userId,
      settings: resolveSettings(job.config ?? null),
    };
  }
  const [project] = await db
    .select({
      userId: projectsTable.userId,
      renderSettings: projectsTable.renderSettings,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  if (!project) {
    throw new Error(`Project ${projectId} not found for Lambda dispatch`);
  }
  return {
    userId: project.userId,
    settings: resolveSettings(project.renderSettings),
  };
}

/**
 * Trigger a render. The ONE function routes should call.
 *
 * Backend selection (M11): `selectBackend(plan)` picks inline | bullmq | lambda.
 * The `plan` arg is OPTIONAL and defaults to `"free"` so existing 4-arg callers
 * keep compiling AND keep their behavior — lambda requires a Pro plan, so a
 * defaulted/free caller can never be routed to lambda, and the inline/bullmq
 * branch below is byte-identical to before this milestone.
 *
 *   - lambda → hand off to the distributed backend (`dispatchLambdaRender`),
 *     which starts a remote execution; the progress poller drives it to done.
 *     A dispatch guard rejection (LambdaDispatchError) is RE-THROWN so the route
 *     releases the project claim and fails the ledger row, exactly like a queue
 *     enqueue failure.
 *   - inline | bullmq → the ORIGINAL path, untouched: durable BullMQ job when
 *     REDIS_URL is set, else inline fire-and-forget.
 */
export async function enqueueRender(
  projectId: number,
  module: string,
  templateId: number | null,
  renderJobId: string,
  plan: "free" | "pro" = "free",
): Promise<void> {
  // Lambda is purely additive — only diverts here when explicitly selected.
  // Everything else falls through to the unchanged inline/bullmq logic so the
  // shipped behavior (and the smoke test) is preserved exactly.
  if (selectBackend(plan) === "lambda") {
    // Prefer the ledger row's gated config snapshot + userId (the route created
    // it from the re-gated settings); fall back to the project's own columns if
    // the row can't be read for any reason.
    const { userId, settings } = await loadDispatchContext(
      projectId,
      renderJobId,
    );
    try {
      await dispatchLambdaRender({
        projectId,
        userId,
        module,
        renderJobId,
        settings,
      });
    } catch (err) {
      // Surface guard rejections to the caller; the route already knows how to
      // release the claim + mark the ledger row failed on an enqueue throw.
      if (err instanceof LambdaDispatchError) throw err;
      // An unexpected dispatch error is logged and re-thrown for the same reason.
      logger.error({ projectId, renderJobId, err }, "Lambda dispatch failed");
      throw err;
    }
    return;
  }

  if (isQueueEnabled()) {
    const q = await getRenderQueue();
    const jobId = jobIdFor(projectId);
    // Drop any finished job sharing this id so a re-render of the same project
    // isn't rejected by the jobId dedup (bounded history keeps Redis tidy).
    await q.remove(jobId).catch(() => undefined);
    await q.add(
      "render",
      { projectId, module, templateId, renderJobId },
      {
        jobId,
        attempts: ATTEMPTS,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
      },
    );
    return;
  }

  // Inline fallback (no Redis): same semantics as the old fire-and-forget.
  void executeRender(projectId, module, templateId, renderJobId).catch((err) =>
    logger.error({ projectId, err }, "Inline render failed"),
  );
}

/** Boot the in-process worker (consumer side). No-op without REDIS_URL. */
export async function startRenderWorker(): Promise<void> {
  if (!isQueueEnabled()) return;
  const { Worker } = await import("bullmq");
  worker = new Worker<RenderJobData>(
    QUEUE_NAME,
    async (job) =>
      executeRender(
        job.data.projectId,
        job.data.module,
        job.data.templateId,
        job.data.renderJobId,
      ),
    { connection: await getConnection(), concurrency: CONCURRENCY },
  );
  worker.on("failed", (job, err) =>
    logger.error({ projectId: job?.data.projectId, err }, "Render job failed"),
  );
  worker.on("error", (err) => logger.error({ err }, "Render worker error"));
  logger.info({ concurrency: CONCURRENCY }, "Render worker started");
}

/**
 * Best-effort removal of a project's job from the queue. Called by the cancel
 * endpoint so a still-queued (not yet active) render never starts; if the job
 * is already active, the worker observes the cancel flag instead (M2). No-op
 * in inline mode, and the remove is swallowed (the job may already be gone).
 */
export async function removeQueuedRender(projectId: number): Promise<void> {
  if (!isQueueEnabled()) return;
  const q = await getRenderQueue();
  await q.remove(jobIdFor(projectId)).catch(() => undefined);
}

/**
 * Whether a project still has an unfinished job in the queue (waiting/active/
 * delayed/etc). Used by startup recovery to avoid resetting jobs the worker
 * will resume. Always false in inline mode.
 */
export async function hasPendingJob(projectId: number): Promise<boolean> {
  if (!isQueueEnabled()) return false;
  const q = await getRenderQueue();
  const state = await q.getJobState(jobIdFor(projectId));
  return state !== "completed" && state !== "failed" && state !== "unknown";
}

/** Drain the worker + queue on shutdown (SIGTERM/SIGINT). */
export async function closeRenderQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  if (connection) connection.disconnect();
  worker = null;
  queue = null;
  connection = null;
}
