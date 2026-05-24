import { initSentry, setupSentryErrorHandler } from "./lib/sentry";
import app from "./app";
import { logger } from "./lib/logger";
import { applyBillingMigration } from "./lib/applyBillingMigration";
import { closeRenderQueue, startRenderWorker } from "./lib/renderQueue";
import { recoverStuckRenders } from "./lib/recoverStuckRenders";

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

// Boot the render worker before recovery so any jobs already persisted in Redis
// start draining immediately; recovery then only resets true orphans (rows in
// "rendering" with no live/pending job). Both are no-ops without REDIS_URL —
// recovery still resets inline-mode orphans whose background render died.
await startRenderWorker();
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
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "Shutting down");
    server.close(() => {
      void closeRenderQueue().finally(() => process.exit(0));
    });
  });
}
