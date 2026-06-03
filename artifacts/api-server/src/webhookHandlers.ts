import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import {
  db,
  processedStripeEventsTable,
  stripeSubscriptionsTable,
} from "@workspace/db";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./lib/logger";

/**
 * Stripe webhook entry point. Verifies the signature, then dispatches
 * subscription lifecycle events into the local stripe_subscriptions cache so
 * `getUserPlan` can serve plan checks without round-tripping to Stripe.
 *
 * The webhook URL is registered manually in the Stripe Dashboard at
 * `${APP_URL}/api/billing/webhook`. STRIPE_WEBHOOK_SECRET must be set.
 *
 * Stripe delivery is at-least-once and unordered, with retries for up to 3
 * days. Two guards keep the cache correct under that reality:
 *   1. Idempotency — each handled `event.id` is recorded in
 *      `processed_stripe_events`; a replay no-ops (the route still 200s, so
 *      Stripe stops retrying).
 *   2. Monotonicity — `upsertSubscription`/`deleteSubscription` compare the
 *      incoming `event.created` against the row's stored watermark and skip
 *      logically-older writes, and treat `deleted` as a terminal tombstone.
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

    // Idempotency: skip an event we have already processed. The route returns
    // 200 either way, which tells Stripe to stop retrying this delivery.
    if (await isEventProcessed(event.id)) {
      logger.debug(
        { eventId: event.id, type: event.type },
        "Stripe webhook event already processed — skipping",
      );
      return;
    }

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.resumed":
      case "customer.subscription.paused":
      case "customer.subscription.trial_will_end":
        await upsertSubscription(
          event.data.object as Stripe.Subscription,
          event.created,
        );
        break;
      case "customer.subscription.deleted":
        await deleteSubscription(
          event.data.object as Stripe.Subscription,
          event.created,
        );
        break;
      default:
        // Other event types are intentionally ignored. Add cases here when
        // additional billing data needs to be synced (invoices, refunds, etc.).
        logger.debug({ type: event.type }, "Stripe webhook ignored");
    }

    // Record only after a successful dispatch: if a handler throws, the event
    // is left unrecorded so Stripe's retry can re-attempt it.
    await markEventProcessed(event.id);
  }
}

/** Returns true if this Stripe event id has already been handled. */
async function isEventProcessed(eventId: string): Promise<boolean> {
  const rows = await db
    .select({ id: processedStripeEventsTable.id })
    .from(processedStripeEventsTable)
    .where(eq(processedStripeEventsTable.id, eventId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Record an event id as processed. `onConflictDoNothing` keeps it safe under a
 * concurrent redelivery of the same id (the second insert is a no-op).
 */
async function markEventProcessed(eventId: string): Promise<void> {
  await db
    .insert(processedStripeEventsTable)
    .values({ id: eventId })
    .onConflictDoNothing({ target: processedStripeEventsTable.id });
}

/** Convert a Stripe Unix-seconds timestamp into a Date, or null. */
function toDate(unixSeconds: number | null | undefined): Date | null {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000) : null;
}

/**
 * Upsert a subscription into the local cache, honouring ordering guards.
 *
 * `eventCreated` is the originating `event.created` (Unix seconds); it defaults
 * to "now" so the function stays directly callable (e.g. in tests). The write
 * is SKIPPED when:
 *   - the row is already a delete tombstone (`deletedAt` set) — terminal, never
 *     resurrect; or
 *   - the incoming event is logically older than the row's stored watermark
 *     (`event_ts`) — a stale, out-of-order redelivery.
 */
export async function upsertSubscription(
  sub: Stripe.Subscription,
  eventCreated: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;

  const periodStart = toDate(item?.current_period_start);
  const periodEnd = toDate(item?.current_period_end);
  const eventTs = toDate(eventCreated);

  const [existing] = await db
    .select({
      eventTs: stripeSubscriptionsTable.eventTs,
      deletedAt: stripeSubscriptionsTable.deletedAt,
    })
    .from(stripeSubscriptionsTable)
    .where(eq(stripeSubscriptionsTable.id, sub.id))
    .limit(1);

  if (existing?.deletedAt) {
    logger.info(
      { subscriptionId: sub.id, customerId, status: sub.status },
      "Stripe subscription upsert skipped — row is a terminal delete tombstone",
    );
    return;
  }

  if (existing?.eventTs && eventTs && eventTs < existing.eventTs) {
    logger.info(
      {
        subscriptionId: sub.id,
        customerId,
        incomingEventTs: eventTs.toISOString(),
        storedEventTs: existing.eventTs.toISOString(),
      },
      "Stripe subscription upsert skipped — stale (out-of-order) event",
    );
    return;
  }

  const values = {
    id: sub.id,
    customerId,
    status: sub.status,
    priceId,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    eventTs,
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
        eventTs: values.eventTs,
        rawJson: values.rawJson,
      },
    });

  logger.info(
    { subscriptionId: sub.id, customerId, status: sub.status },
    "Stripe subscription upserted",
  );
}

/**
 * Handle `customer.subscription.deleted` as a TERMINAL tombstone rather than a
 * hard row delete: the row is set to status 'canceled' (which `getUserPlan`
 * already treats as non-pro) with `deletedAt` stamped. Keeping the row — and
 * making `upsertSubscription` refuse to overwrite a tombstoned row — means a
 * `deleted` that arrives BEFORE a logically-older `updated(active)` can no
 * longer be undone by that late update.
 *
 * Idempotent: a redelivered `deleted` on an already-tombstoned row no-ops.
 */
export async function deleteSubscription(
  sub: Stripe.Subscription,
  eventCreated: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const eventTs = toDate(eventCreated);

  const [existing] = await db
    .select({
      eventTs: stripeSubscriptionsTable.eventTs,
      deletedAt: stripeSubscriptionsTable.deletedAt,
    })
    .from(stripeSubscriptionsTable)
    .where(eq(stripeSubscriptionsTable.id, sub.id))
    .limit(1);

  if (existing?.deletedAt) {
    logger.debug(
      { subscriptionId: sub.id },
      "Stripe subscription already tombstoned — skipping delete",
    );
    return;
  }

  // Tombstone is terminal regardless of the relative timestamp: Stripe will not
  // re-activate a deleted subscription id, so we always record the cancellation.
  // The watermark is advanced to the max of the incoming and any stored event
  // time so a *newer* upsert (a genuinely later event) is still admissible only
  // via a fresh row — which Stripe never produces for a deleted id.
  const watermark =
    existing?.eventTs && eventTs && existing.eventTs > eventTs
      ? existing.eventTs
      : eventTs;

  await db
    .insert(stripeSubscriptionsTable)
    .values({
      id: sub.id,
      customerId,
      status: "canceled",
      priceId: sub.items.data[0]?.price?.id ?? null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      eventTs: watermark,
      deletedAt: eventTs ?? new Date(),
      rawJson: sub as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: stripeSubscriptionsTable.id,
      set: {
        status: "canceled",
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        eventTs: watermark,
        deletedAt: eventTs ?? new Date(),
        rawJson: sub as unknown as Record<string, unknown>,
      },
    });

  logger.info(
    { subscriptionId: sub.id, customerId },
    "Stripe subscription tombstoned (canceled)",
  );
}
