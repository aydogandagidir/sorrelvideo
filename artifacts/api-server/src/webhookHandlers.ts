import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db, stripeSubscriptionsTable } from "@workspace/db";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./lib/logger";

/**
 * Stripe webhook entry point. Verifies the signature, then dispatches
 * subscription lifecycle events into the local stripe_subscriptions cache so
 * `getUserPlan` can serve plan checks without round-tripping to Stripe.
 *
 * The webhook URL is registered manually in the Stripe Dashboard at
 * `${APP_URL}/api/billing/webhook`. STRIPE_WEBHOOK_SECRET must be set.
 */
export class WebhookHandlers {
  static async processWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        `Webhook payload must be a raw Buffer (got ${typeof payload}). ` +
          "Ensure the webhook route is registered before express.json().",
      );
    }

    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error("STRIPE_WEBHOOK_SECRET is not set");
    }

    const stripe = await getUncachableStripeClient();
    const event = stripe.webhooks.constructEvent(payload, signature, secret);

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.resumed":
      case "customer.subscription.paused":
      case "customer.subscription.trial_will_end":
        await upsertSubscription(event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await deleteSubscription(event.data.object as Stripe.Subscription);
        break;
      default:
        // Other event types are intentionally ignored. Add cases here when
        // additional billing data needs to be synced (invoices, refunds, etc.).
        logger.debug({ type: event.type }, "Stripe webhook ignored");
    }
  }
}

async function upsertSubscription(sub: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;

  const periodStart = item?.current_period_start
    ? new Date(item.current_period_start * 1000)
    : null;
  const periodEnd = item?.current_period_end
    ? new Date(item.current_period_end * 1000)
    : null;

  const values = {
    id: sub.id,
    customerId,
    status: sub.status,
    priceId,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    rawJson: sub as unknown as Record<string, unknown>,
  };

  await db
    .insert(stripeSubscriptionsTable)
    .values(values)
    .onConflictDoUpdate({
      target: stripeSubscriptionsTable.id,
      set: {
        customerId: values.customerId,
        status: values.status,
        priceId: values.priceId,
        currentPeriodStart: values.currentPeriodStart,
        currentPeriodEnd: values.currentPeriodEnd,
        cancelAtPeriodEnd: values.cancelAtPeriodEnd,
        rawJson: values.rawJson,
      },
    });

  logger.info(
    { subscriptionId: sub.id, customerId, status: sub.status },
    "Stripe subscription upserted",
  );
}

async function deleteSubscription(sub: Stripe.Subscription): Promise<void> {
  await db
    .delete(stripeSubscriptionsTable)
    .where(eq(stripeSubscriptionsTable.id, sub.id));

  logger.info({ subscriptionId: sub.id }, "Stripe subscription deleted");
}
