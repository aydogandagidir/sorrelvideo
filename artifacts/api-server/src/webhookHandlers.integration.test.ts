import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import {
  db,
  processedStripeEventsTable,
  stripeSubscriptionsTable,
} from "@workspace/db";
import { truncateAll } from "./test/integration";
import { INTEGRATION_AVAILABLE } from "./test/setup";

// Mock the Stripe client so processWebhook can be driven without a real
// signature: constructEvent simply parses the (test-authored) JSON payload.
// upsertSubscription / deleteSubscription don't touch the Stripe client, so
// this mock leaves their behaviour untouched.
vi.mock("./stripeClient", () => ({
  getUncachableStripeClient: vi.fn(async () => ({
    webhooks: {
      constructEvent: (payload: Buffer) =>
        JSON.parse(payload.toString("utf8")) as Stripe.Event,
    },
  })),
}));

// Imported AFTER the mock declaration (vi.mock is hoisted) so the SUT picks up
// the mocked Stripe client.
const { WebhookHandlers, deleteSubscription, upsertSubscription } =
  await import("./webhookHandlers");

const SUB_ID = "sub_test_123";
const CUSTOMER_ID = "cus_test_abc";

beforeEach(async () => {
  await truncateAll();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});

function makeSub(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  const base = {
    id: SUB_ID,
    customer: CUSTOMER_ID,
    status: "active",
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: "si_1",
          price: { id: "price_basic_monthly" },
          current_period_start: Math.floor(Date.now() / 1000) - 60,
          current_period_end: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
  return { ...base, ...overrides } as Stripe.Subscription;
}

/** Build a Stripe.Event envelope around a subscription object. */
function makeEvent(
  type: Stripe.Event.Type,
  sub: Stripe.Subscription,
  opts: { id?: string; created?: number } = {},
): Stripe.Event {
  return {
    id: opts.id ?? "evt_test_1",
    type,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    data: { object: sub },
  } as unknown as Stripe.Event;
}

async function readSub() {
  const [row] = await db
    .select()
    .from(stripeSubscriptionsTable)
    .where(eq(stripeSubscriptionsTable.id, SUB_ID));
  return row;
}

describe.runIf(INTEGRATION_AVAILABLE)("upsertSubscription", () => {
  it("inserts a row for a brand-new subscription event", async () => {
    await upsertSubscription(makeSub());

    const row = await readSub();
    expect(row).toBeDefined();
    expect(row.customerId).toBe(CUSTOMER_ID);
    expect(row.status).toBe("active");
    expect(row.priceId).toBe("price_basic_monthly");
    expect(row.cancelAtPeriodEnd).toBe(false);
  });

  it("updates the existing row on conflict (status, cancel flag)", async () => {
    await upsertSubscription(makeSub(), 1000);
    await upsertSubscription(
      makeSub({
        status: "canceled" as Stripe.Subscription.Status,
        cancel_at_period_end: true,
      }),
      2000, // newer event → applied
    );

    const rows = await db
      .select()
      .from(stripeSubscriptionsTable)
      .where(eq(stripeSubscriptionsTable.id, SUB_ID));

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("canceled");
    expect(rows[0].cancelAtPeriodEnd).toBe(true);
  });

  it("skips a logically-older (out-of-order) update", async () => {
    // Newer event lands first (active), then an older event tries to cancel.
    await upsertSubscription(makeSub({ status: "active" }), 2000);
    await upsertSubscription(
      makeSub({ status: "canceled" as Stripe.Subscription.Status }),
      1000, // older than the stored watermark → skipped
    );

    const row = await readSub();
    expect(row.status).toBe("active");
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("deleteSubscription (tombstone)", () => {
  it("tombstones the row (status canceled) instead of deleting it", async () => {
    await upsertSubscription(makeSub(), 1000);
    await deleteSubscription(makeSub(), 2000);

    const row = await readSub();
    expect(row).toBeDefined();
    expect(row.status).toBe("canceled");
    expect(row.deletedAt).not.toBeNull();
  });

  it("tombstones even when the deleted event arrives before the row exists", async () => {
    await deleteSubscription(makeSub(), 2000);

    const row = await readSub();
    expect(row).toBeDefined();
    expect(row.status).toBe("canceled");
    expect(row.deletedAt).not.toBeNull();
  });

  it("out-of-order deleted-then-updated: stays canceled (no resurrection)", async () => {
    // deleted arrives first (logically older), then a later updated(active).
    await deleteSubscription(makeSub(), 1000);
    await upsertSubscription(makeSub({ status: "active" }), 2000);

    const row = await readSub();
    expect(row.status).toBe("canceled"); // tombstone is terminal
    expect(row.deletedAt).not.toBeNull();
  });

  it("in-order updated-then-deleted: ends canceled", async () => {
    await upsertSubscription(makeSub({ status: "active" }), 1000);
    await deleteSubscription(makeSub(), 2000);

    const row = await readSub();
    expect(row.status).toBe("canceled");
    expect(row.deletedAt).not.toBeNull();
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("processWebhook idempotency", () => {
  it("records the event id and no-ops a replay of the same event id", async () => {
    const event = makeEvent("customer.subscription.created", makeSub(), {
      id: "evt_replay_1",
      created: 1000,
    });
    const payload = Buffer.from(JSON.stringify(event), "utf8");

    await WebhookHandlers.processWebhook(payload, "sig");

    // First delivery applied + recorded.
    expect((await readSub()).status).toBe("active");
    const [ledger] = await db
      .select()
      .from(processedStripeEventsTable)
      .where(eq(processedStripeEventsTable.id, "evt_replay_1"));
    expect(ledger).toBeDefined();

    // A later, logically-newer cancel for the SAME subscription but carrying
    // the ALREADY-PROCESSED event id must be skipped wholesale (no DB write),
    // proving dedup runs before dispatch.
    const replay = makeEvent(
      "customer.subscription.updated",
      makeSub({ status: "canceled" as Stripe.Subscription.Status }),
      { id: "evt_replay_1", created: 5000 },
    );
    await WebhookHandlers.processWebhook(
      Buffer.from(JSON.stringify(replay), "utf8"),
      "sig",
    );

    expect((await readSub()).status).toBe("active");
  });

  it("does NOT record the event id when the handler throws (retry can re-run)", async () => {
    // A malformed subscription object (no items array) makes upsert throw.
    const bad = {
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: "active",
      cancel_at_period_end: false,
      // items intentionally omitted → upsertSubscription dereferences items.data
    } as unknown as Stripe.Subscription;
    const event = makeEvent("customer.subscription.created", bad, {
      id: "evt_fail_1",
      created: 1000,
    });

    await expect(
      WebhookHandlers.processWebhook(
        Buffer.from(JSON.stringify(event), "utf8"),
        "sig",
      ),
    ).rejects.toBeDefined();

    const ledger = await db
      .select()
      .from(processedStripeEventsTable)
      .where(eq(processedStripeEventsTable.id, "evt_fail_1"));
    expect(ledger).toHaveLength(0);
  });
});
