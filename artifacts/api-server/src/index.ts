import app from "./app";
import { logger } from "./lib/logger";
import { applyBillingMigration } from "./lib/applyBillingMigration";

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

app.listen(port, (err) => {
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
