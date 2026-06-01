import type { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "./logger";
import { executeRender } from "../services/renderService";

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
  connection.on("error", (err) => logger.error({ err }, "Redis connection error"));
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
 * Trigger a render. The ONE function routes should call. Enqueues a durable job
 * when Redis is configured; otherwise runs inline (fire-and-forget), preserving
 * the original 202-then-background behavior.
 */
export async function enqueueRender(
  projectId: number,
  module: string,
  templateId: number | null,
  renderJobId: string,
): Promise<void> {
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
