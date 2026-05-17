import { beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db, stripeSubscriptionsTable } from "@workspace/db";
import { deleteSubscription, upsertSubscription } from "./webhookHandlers";
import { truncateAll } from "./test/integration";
import { INTEGRATION_AVAILABLE } from "./test/setup";

beforeEach(async () => {
  await truncateAll();
});

function makeSub(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  const base = {
    id: "sub_test_123",
    customer: "cus_test_abc",
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

describe.runIf(INTEGRATION_AVAILABLE)("upsertSubscription", () => {
  it("inserts a row for a brand-new subscription event", async () => {
    await upsertSubscription(makeSub());

    const [row] = await db
      .select()
      .from(stripeSubscriptionsTable)
      .where(eq(stripeSubscriptionsTable.id, "sub_test_123"));

    expect(row).toBeDefined();
    expect(row.customerId).toBe("cus_test_abc");
    expect(row.status).toBe("active");
    expect(row.priceId).toBe("price_basic_monthly");
    expect(row.cancelAtPeriodEnd).toBe(false);
  });

  it("updates the existing row on conflict (status, cancel flag)", async () => {
    await upsertSubscription(makeSub());
    await upsertSubscription(
      makeSub({
        status: "canceled" as Stripe.Subscription.Status,
        cancel_at_period_end: true,
      }),
    );

    const rows = await db
      .select()
      .from(stripeSubscriptionsTable)
      .where(eq(stripeSubscriptionsTable.id, "sub_test_123"));

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("canceled");
    expect(rows[0].cancelAtPeriodEnd).toBe(true);
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("deleteSubscription", () => {
  it("removes the row when the customer.subscription.deleted event fires", async () => {
    await upsertSubscription(makeSub());
    await deleteSubscription(makeSub());

    const rows = await db
      .select()
      .from(stripeSubscriptionsTable)
      .where(eq(stripeSubscriptionsTable.id, "sub_test_123"));

    expect(rows).toHaveLength(0);
  });
});
