import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, stripeSubscriptionsTable, usersTable } from "@workspace/db";
import {
  FREE_AI_LIMIT,
  FREE_RENDER_LIMIT,
  checkAndIncrementAiCount,
  checkAndIncrementRenderCount,
  getBillingInfo,
} from "./billingService";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

async function createFreeUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `free-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

async function createProUser(): Promise<string> {
  const customerId = `cus_test_${Math.random().toString(36).slice(2)}`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `pro-${Date.now()}-${Math.random()}@test.local`,
      stripeCustomerId: customerId,
    })
    .returning();
  await db.insert(stripeSubscriptionsTable).values({
    id: `sub_${customerId}`,
    customerId,
    status: "active",
    cancelAtPeriodEnd: false,
  });
  return row.id;
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "checkAndIncrementRenderCount — race + quota",
  () => {
    it("only allows FREE_RENDER_LIMIT (3) concurrent increments for a free user", async () => {
      const userId = await createFreeUser();

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => checkAndIncrementRenderCount(userId)),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );

      expect(fulfilled).toBe(FREE_RENDER_LIMIT);
      expect(rejected).toHaveLength(5 - FREE_RENDER_LIMIT);
      for (const r of rejected) {
        expect((r.reason as { reason?: string }).reason).toBe(
          "upgrade_required",
        );
      }

      const [updated] = await db
        .select({ renderCount: usersTable.renderCount })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      expect(updated.renderCount).toBe(FREE_RENDER_LIMIT);
    });

    it("does not increment render_count for pro users", async () => {
      const userId = await createProUser();

      await checkAndIncrementRenderCount(userId);
      await checkAndIncrementRenderCount(userId);
      await checkAndIncrementRenderCount(userId);
      await checkAndIncrementRenderCount(userId);

      const [updated] = await db
        .select({ renderCount: usersTable.renderCount })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      expect(updated.renderCount).toBe(0);
    });
  },
);

describe.runIf(INTEGRATION_AVAILABLE)(
  "checkAndIncrementAiCount — race + quota",
  () => {
    it("only allows FREE_AI_LIMIT (10) concurrent increments for a free user", async () => {
      const userId = await createFreeUser();

      const results = await Promise.allSettled(
        Array.from({ length: FREE_AI_LIMIT + 4 }, () =>
          checkAndIncrementAiCount(userId),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      expect(fulfilled).toBe(FREE_AI_LIMIT);

      const [updated] = await db
        .select({ aiCount: usersTable.aiCount })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      expect(updated.aiCount).toBe(FREE_AI_LIMIT);
    });

    it("does not increment ai_count for pro users", async () => {
      const userId = await createProUser();

      await Promise.all(
        Array.from({ length: 5 }, () => checkAndIncrementAiCount(userId)),
      );

      const [updated] = await db
        .select({ aiCount: usersTable.aiCount })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      expect(updated.aiCount).toBe(0);
    });
  },
);

describe.runIf(INTEGRATION_AVAILABLE)("getBillingInfo", () => {
  it("returns the live counters and the right limits for a free user", async () => {
    const userId = await createFreeUser();
    await checkAndIncrementRenderCount(userId);
    await checkAndIncrementAiCount(userId);
    await checkAndIncrementAiCount(userId);

    const info = await getBillingInfo(userId);
    expect(info.plan).toBe("free");
    expect(info.renderCount).toBe(1);
    expect(info.renderLimit).toBe(FREE_RENDER_LIMIT);
    expect(info.aiCount).toBe(2);
    expect(info.aiLimit).toBe(FREE_AI_LIMIT);
  });

  it("returns null limits and zero counters for a pro user", async () => {
    const userId = await createProUser();

    const info = await getBillingInfo(userId);
    expect(info.plan).toBe("pro");
    expect(info.renderLimit).toBeNull();
    expect(info.aiLimit).toBeNull();
  });
});
