import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * `/api/healthz` is Railway's only healthcheck (railway.json), so it must be a
 * *readiness* probe, not a static 200. A static `{ status: "ok" }` cannot tell
 * the platform that the process can't reach its backing stores — Railway would
 * keep routing traffic to an instance whose every authed request 500s on a dead
 * DB. So this pings the dependencies the app cannot serve a request without:
 *
 *   - Postgres: a trivial `SELECT 1` over the shared pool.
 *   - Redis (only when REDIS_URL is set): a `PING` over a short-lived, strictly
 *     bounded connection. Redis is optional (renders fall back to inline), but
 *     when it IS configured a dead broker means the durable queue is broken, so
 *     it counts toward readiness.
 *
 * The probe is kept fast and dependency-light: each check is wrapped in a hard
 * timeout so a hung dependency surfaces as 503 instead of stalling the platform
 * healthcheck, and ioredis is imported lazily so the Redis path costs nothing
 * when unconfigured (mirrors lib/renderQueue's no-op philosophy).
 *
 * Healthy → 200 `{ status: "ok" }` (the documented HealthStatus shape). Any
 * failed check → 503 with a small JSON body naming the unhealthy dependency, so
 * logs/dashboards show *why* an instance was pulled.
 */

/** Hard ceiling for any single dependency probe. Keeps the endpoint snappy. */
const CHECK_TIMEOUT_MS = 5_000;

/** Reject after `ms` so a hung dependency can never stall the healthcheck. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} check timed out after ${ms}ms`));
    }, ms);
    // Don't keep the event loop alive solely for this guard timer.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** `SELECT 1` over the shared pool — the cheapest "is Postgres reachable" probe. */
async function checkDatabase(): Promise<void> {
  await withTimeout(pool.query("SELECT 1"), CHECK_TIMEOUT_MS, "database");
}

/**
 * `PING` over a throwaway ioredis client. We deliberately do NOT reuse the
 * BullMQ connection from lib/renderQueue: that one is configured with
 * `maxRetriesPerRequest: null`, which makes a command against a dead broker hang
 * indefinitely — the opposite of what a healthcheck wants. Instead we open a
 * single-attempt, lazily-connected client, ping it, and always tear it down.
 */
async function checkRedis(): Promise<void> {
  const { default: IORedis } = await import("ioredis");
  const client = new IORedis(process.env.REDIS_URL as string, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: CHECK_TIMEOUT_MS,
    // A probe must fail fast, not spin reconnect attempts.
    retryStrategy: () => null,
  });
  // Swallow async 'error' events so a connection failure rejects the awaited
  // ping/connect below instead of surfacing as an unhandled error.
  client.on("error", () => {});
  try {
    await withTimeout(
      (async () => {
        await client.connect();
        await client.ping();
      })(),
      CHECK_TIMEOUT_MS,
      "redis",
    );
  } finally {
    client.disconnect();
  }
}

router.get("/healthz", async (_req, res) => {
  const checks: Record<string, "ok" | "error"> = { database: "ok" };
  let healthy = true;

  try {
    await checkDatabase();
  } catch (err) {
    healthy = false;
    checks.database = "error";
    logger.error({ err }, "Healthcheck: database probe failed");
  }

  if (process.env.REDIS_URL) {
    checks.redis = "ok";
    try {
      await checkRedis();
    } catch (err) {
      healthy = false;
      checks.redis = "error";
      logger.error({ err }, "Healthcheck: redis probe failed");
    }
  }

  if (!healthy) {
    res.status(503).json({ status: "error", checks });
    return;
  }

  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
