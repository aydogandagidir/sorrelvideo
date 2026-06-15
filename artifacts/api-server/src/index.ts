import { initSentry, setupSentryErrorHandler } from "./lib/sentry";
import app from "./app";
import { logger } from "./lib/logger";
import { applyBillingMigration } from "./lib/applyBillingMigration";
import { applyRenderJobsMigration } from "./lib/applyRenderJobsMigration";
import { applyBrandKitMigration } from "./lib/applyBrandKitMigration";
import { applyAvatarSessionsMigration } from "./lib/applyAvatarSessionsMigration";
import { closeRenderQueue, startRenderWorker } from "./lib/renderQueue";
import { recoverStuckRenders } from "./lib/recoverStuckRenders";
import {
  startLambdaProgressPoller,
  stopLambdaProgressPoller,
} from "./lib/lambdaProgressPoller";
import { seedPlatformTemplates } from "./services/platformTemplatesService";
import { seedModules } from "./services/modulesService";

// Initialise Sentry (no-op without SENTRY_DSN), then wire its Express error
// handler. Lazy-loaded so dev boots without the OpenTelemetry dependency graph.
await initSentry();
setupSentryErrorHandler(app);

async function initBilling(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL not set — skipping billing migration");
    return;
  }

  try {
    await applyBillingMigration();
  } catch (err) {
    logger.warn({ err }, "Billing migration failed — payments may misbehave");
  }
}

async function initRenderJobs(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL not set — skipping render-jobs migration");
    return;
  }

  try {
    await applyRenderJobsMigration();
  } catch (err) {
    // The render-jobs ledger row is created on every render; without the table
    // each render 500s. Surface this loudly so a missed `db push` is obvious.
    logger.warn(
      { err },
      "Render-jobs migration failed — renders may fail to start",
    );
  }
}

async function initBrandKits(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL not set — skipping brand-kit migration");
    return;
  }

  try {
    await applyBrandKitMigration();
  } catch (err) {
    logger.warn(
      { err },
      "Brand-kit migration failed — brand kits may misbehave",
    );
  }
}

async function initAvatarSessions(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL not set — skipping avatar-sessions migration");
    return;
  }

  try {
    await applyAvatarSessionsMigration();
  } catch (err) {
    logger.warn(
      { err },
      "Avatar-sessions migration failed — avatar usage won't be logged",
    );
  }
}

async function initTemplates(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL not set — skipping platform template seed");
    return;
  }

  try {
    const seeded = await seedPlatformTemplates();
    if (seeded > 0) logger.info({ seeded }, "Seeded platform templates");
  } catch (err) {
    logger.warn({ err }, "Platform template seed failed — gallery may be empty");
  }
}

async function initModules(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL not set — skipping module catalog seed");
    return;
  }

  try {
    const seeded = await seedModules();
    if (seeded > 0) logger.info({ seeded }, "Seeded platform modules");
  } catch (err) {
    logger.warn({ err }, "Module catalog seed failed — /modules may be empty");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await initBilling();
await initRenderJobs();
await initBrandKits();
await initAvatarSessions();
await initTemplates();
await initModules();

// Boot the render worker before recovery so any jobs already persisted in Redis
// start draining immediately; recovery then only resets true orphans (rows in
// "rendering" with no live/pending job). Both are no-ops without REDIS_URL —
// recovery still resets inline-mode orphans whose background render died.
await startRenderWorker();
// Start the distributed (Lambda) progress poller. No-op unless the lambda
// backend is active (RENDER_BACKEND=lambda|auto AND AWS env present), so this is
// inert in dev/test and the inline/bullmq deployments.
startLambdaProgressPoller();
await recoverStuckRenders();

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    logger.warn(
      "STRIPE_WEBHOOK_SECRET is not set — POST /api/billing/webhook will reject events. " +
        "Configure the webhook in the Stripe Dashboard at ${APP_URL}/api/billing/webhook " +
        "and copy the signing secret into your environment.",
    );
  }
});

// Graceful shutdown: stop accepting connections, then drain the render worker
// so an in-flight render finishes (or is requeued) before the process exits.
//
// `server.close` waits for ALL in-flight requests to finish, including a long
// render or a held video-stream socket — which can outlast Railway's grace
// window between SIGTERM and SIGKILL. A SIGKILL mid-shutdown leaves a project
// stranded in "rendering" (only recovered on the next boot). So we arm a bounded
// forced-exit timer alongside the graceful path: whichever fires first wins. The
// timer is `.unref()`'d so it never keeps the process alive on its own when the
// graceful close already completed.
const FORCED_EXIT_MS = 25_000;
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return; // ignore a second signal during shutdown
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    stopLambdaProgressPoller();

    const forceExit = setTimeout(() => {
      logger.error(
        { timeoutMs: FORCED_EXIT_MS },
        "Graceful shutdown timed out — forcing exit",
      );
      process.exit(1);
    }, FORCED_EXIT_MS);
    forceExit.unref();

    server.close(() => {
      void closeRenderQueue().finally(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  });
}
