import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, brandKitTable } from "@workspace/db";
import { applyBrandKitMigration } from "./applyBrandKitMigration";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

beforeEach(async () => {
  await truncateAll();
});

async function defaultsFor(userId: string) {
  return db
    .select()
    .from(brandKitTable)
    .where(
      and(eq(brandKitTable.userId, userId), eq(brandKitTable.isDefault, true)),
    );
}

describe.runIf(INTEGRATION_AVAILABLE)("applyBrandKitMigration", () => {
  it("is safe to run twice (idempotent ADD COLUMN / DROP CONSTRAINT / CREATE INDEX)", async () => {
    await expect(applyBrandKitMigration()).resolves.toBeUndefined();
    await expect(applyBrandKitMigration()).resolves.toBeUndefined();
  });

  it("back-fills exactly one default per user — the earliest kit — and re-runs as a no-op", async () => {
    const userId = await createFreeUser();
    // Two legacy-style kits, neither default (the pre-multi-kit world).
    const [first] = await db
      .insert(brandKitTable)
      .values({ userId, name: "First", isDefault: false })
      .returning();
    await db
      .insert(brandKitTable)
      .values({ userId, name: "Second", isDefault: false });

    await applyBrandKitMigration();

    const defaults = await defaultsFor(userId);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(first.id); // the earliest (MIN id)

    // Re-run must not promote a second default (NOT EXISTS guard).
    await applyBrandKitMigration();
    const after = await defaultsFor(userId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first.id);
  });

  it("leaves a user who already has a default untouched", async () => {
    const userId = await createFreeUser();
    const [chosen] = await db
      .insert(brandKitTable)
      .values({ userId, name: "A", isDefault: true })
      .returning();
    await db
      .insert(brandKitTable)
      .values({ userId, name: "B", isDefault: false });

    await applyBrandKitMigration();

    const defaults = await defaultsFor(userId);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(chosen.id);
  });

  it("enforces at most one default per user (partial-unique index)", async () => {
    const userId = await createFreeUser();
    await db.insert(brandKitTable).values({ userId, name: "A", isDefault: true });
    // A second default for the same user must violate UQ_brand_kit_default.
    await expect(
      db.insert(brandKitTable).values({ userId, name: "B", isDefault: true }),
    ).rejects.toThrow();
  });
});
