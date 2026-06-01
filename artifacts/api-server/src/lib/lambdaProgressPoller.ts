/**
 * Lambda progress poller (M11) — the SINGLE in-process writer that drives
 * distributed (Lambda) renders to completion.
 *
 * The Lambda backend dispatches a render and returns immediately with an
 * execution ARN; there are no completion webhooks (the CDK stack is poll-only).
 * This poller closes that loop: every `LAMBDA_PROGRESS_POLL_MS` it loads every
 * in-flight row (`backend='lambda'`, `status='rendering'`) and reconciles each
 * via `reconcileLambdaJob` — writing progress/cost and finalizing terminal jobs.
 *
 * No-op safety: `startLambdaProgressPoller()` returns immediately unless the
 * lambda backend is actually active (RENDER_BACKEND lambda|auto AND the AWS env
 * present), so dev/test/CI with no AWS never start a timer. A re-entrancy guard
 * (`running`) ensures ticks never overlap even if a poll outlasts the interval —
 * making this a single writer per process, as required.
 */
import { logger } from "./logger";
import { isLambdaBackendActive } from "./renderBackend";
import { getActiveLambdaJobs } from "../services/renderJobsService";
import { reconcileLambdaJob } from "./renderBackends/lambdaBackend";

const POLL_MS = Number(process.env.LAMBDA_PROGRESS_POLL_MS ?? "8000") || 8000;

let timer: NodeJS.Timeout | null = null;
/** Re-entrancy guard: true while a tick is in flight (prevents overlap). */
let running = false;

/** One reconcile sweep over all in-flight Lambda jobs. Never throws. */
async function tick(): Promise<void> {
  if (running) return; // a previous (slow) tick is still going — skip this one.
  running = true;
  try {
    const jobs = await getActiveLambdaJobs();
    // Sequential on purpose: keeps it a single writer and avoids hammering the
    // remote getRenderProgress / DB with a burst. The in-flight set is small
    // (bounded by the dispatch-side cap), so serial latency is fine.
    for (const job of jobs) {
      await reconcileLambdaJob(job);
    }
  } catch (err) {
    logger.warn({ err }, "Lambda progress poll tick failed");
  } finally {
    running = false;
  }
}

/**
 * Boot the poller. No-op unless the lambda backend is active. Idempotent — a
 * second call while already running is ignored. The interval is `unref`'d so it
 * never keeps the process alive on its own (graceful shutdown still works).
 */
export function startLambdaProgressPoller(): void {
  if (timer) return;
  if (!isLambdaBackendActive()) return;

  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
  // Don't let the poll timer pin the event loop open during shutdown.
  timer.unref?.();

  logger.info({ pollMs: POLL_MS }, "Lambda progress poller started");
}

/** Stop the poller (used on shutdown / in tests). */
export function stopLambdaProgressPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
