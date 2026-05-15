import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripeClient";
import { applyBillingMigration } from "./lib/applyBillingMigration";

async function initStripe(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set — skipping Stripe init");
    return;
  }

  try {
    // Ensure billing columns exist on the users table before any request touches them.
    await applyBillingMigration();

    logger.info("Initializing Stripe schema...");
    await runMigrations({ databaseUrl });
    logger.info("Stripe schema ready");

    const stripeSync = await getStripeSync();

    const primaryDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
    if (!primaryDomain) {
      logger.warn("REPLIT_DOMAINS not set — skipping webhook registration");
    } else {
      await stripeSync.findOrCreateManagedWebhook(
        `https://${primaryDomain}/api/billing/webhook`,
      );
    }

    stripeSync.syncBackfill().then(() => {
      logger.info("Stripe backfill complete");
    }).catch((err) => {
      logger.error({ err }, "Stripe backfill error");
    });
  } catch (err) {
    logger.warn({ err }, "Stripe init failed — payments will be unavailable");
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

await initStripe();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
