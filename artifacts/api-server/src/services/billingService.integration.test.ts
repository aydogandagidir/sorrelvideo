import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  FREE_AI_LIMIT,
  FREE_RENDER_LIMIT,
  checkAndIncrementAiCount,
  checkAndIncrementRenderCount,
  decrementRenderCount,
  getBillingInfo,
} from "./billingService";
import { createFreeUser, createProUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

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

  it("month-boundary reset under getBillingInfo never clobbers a concurrent increment", async () => {
    // Reproduce the month-rollover race: a non-zero count carried from the prior
    // window with an ALREADY-PAST reset_at. The OLD getBillingInfo did an
    // UNLOCKED `render_count = 0` write that could land AFTER a concurrent
    // increment committed, dropping a just-charged render back to 0 (free-usage
    // leak). Now the reset takes the same row lock, so the two serialize and the
    // net result is deterministic: reset-then-increment leaves exactly 1.
    const userId = await createFreeUser();
    await db
      .update(usersTable)
      .set({ renderCount: 2, renderResetAt: new Date(Date.now() - 60_000) })
      .where(eq(usersTable.id, userId));

    await Promise.all([
      checkAndIncrementRenderCount(userId),
      getBillingInfo(userId),
    ]);

    const [updated] = await db
      .select({ renderCount: usersTable.renderCount })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    // Never 0 (the regression) — the rolled-over window resets once, then the
    // increment lands on top of it.
    expect(updated.renderCount).toBe(1);
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("decrementRenderCount — refund", () => {
  it("refunds one render charged in the current window", async () => {
    const userId = await createFreeUser();
    // Two increments set render_reset_at to a FUTURE start-of-next-month, i.e.
    // the current window — so a refund applies.
    await checkAndIncrementRenderCount(userId);
    await checkAndIncrementRenderCount(userId);

    await decrementRenderCount(userId);

    const [updated] = await db
      .select({ renderCount: usersTable.renderCount })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(updated.renderCount).toBe(1);
  });

  it("floors at 0 and never goes negative on an over-refund", async () => {
    const userId = await createFreeUser();
    await checkAndIncrementRenderCount(userId); // count = 1, current window

    await decrementRenderCount(userId); // → 0
    await decrementRenderCount(userId); // stays 0 (nothing to refund)

    const [updated] = await db
      .select({ renderCount: usersTable.renderCount })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(updated.renderCount).toBe(0);
  });

  it("does not refund a charge from a rolled-over (expired) window", async () => {
    // A count carried from a PAST window must not be decremented — the next read
    // zeroes it anyway, and refunding would steal from next month's allowance.
    const userId = await createFreeUser();
    await db
      .update(usersTable)
      .set({ renderCount: 2, renderResetAt: new Date(Date.now() - 60_000) })
      .where(eq(usersTable.id, userId));

    await decrementRenderCount(userId);

    const [updated] = await db
      .select({ renderCount: usersTable.renderCount })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(updated.renderCount).toBe(2);
  });

  it("restores a quota slot so a failed render can be retried", async () => {
    // End-to-end of the refund's purpose: a Free user at the 3-render cap whose
    // render failed (→ refund) can charge one more, instead of being locked out.
    const userId = await createFreeUser();
    await checkAndIncrementRenderCount(userId);
    await checkAndIncrementRenderCount(userId);
    await checkAndIncrementRenderCount(userId); // at FREE_RENDER_LIMIT

    await expect(checkAndIncrementRenderCount(userId)).rejects.toMatchObject({
      reason: "upgrade_required",
    });

    // Simulate the failed render giving the slot back.
    await decrementRenderCount(userId);

    // The retry now succeeds.
    await expect(checkAndIncrementRenderCount(userId)).resolves.toBeUndefined();

    const [updated] = await db
      .select({ renderCount: usersTable.renderCount })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(updated.renderCount).toBe(FREE_RENDER_LIMIT);
  });

  it("is a harmless no-op for a pro user (never charged)", async () => {
    const userId = await createProUser();
    await checkAndIncrementRenderCount(userId); // pro: count stays 0

    await decrementRenderCount(userId);

    const [updated] = await db
      .select({ renderCount: usersTable.renderCount })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(updated.renderCount).toBe(0);
  });
});
