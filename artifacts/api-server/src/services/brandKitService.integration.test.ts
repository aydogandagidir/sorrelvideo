import { beforeEach, describe, expect, it } from "vitest";
import { db, usersTable } from "@workspace/db";
import {
  createBrandKit,
  updateBrandKit,
  deleteBrandKit,
  listBrandKits,
  getDefaultBrandKit,
  isConfiguredBrandKit,
} from "./brandKitService";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * The single-default invariant (partial-unique UQ_brand_kit_default) and the
 * service logic that maintains it: exactly one default per user at all times,
 * the first kit auto-defaults, promotions demote the previous default, and
 * deleting the default promotes the earliest remaining kit.
 */

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `kit-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("brandKitService — default invariant", () => {
  it("makes the first kit default and keeps later kits non-default", async () => {
    const userId = await createUser();
    const first = await createBrandKit(userId, { name: "A" });
    const second = await createBrandKit(userId, { name: "B" });

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect((await getDefaultBrandKit(userId))?.id).toBe(first.id);
  });

  it("creating a kit as default demotes the previous default (one default only)", async () => {
    const userId = await createUser();
    const first = await createBrandKit(userId, { name: "A" });
    const second = await createBrandKit(userId, { name: "B", isDefault: true });

    const kits = await listBrandKits(userId);
    expect(kits.filter((k) => k.isDefault)).toHaveLength(1);
    expect((await getDefaultBrandKit(userId))?.id).toBe(second.id);
    const reloadedFirst = kits.find((k) => k.id === first.id);
    expect(reloadedFirst?.isDefault).toBe(false);
  });

  it("promoting a kit via update moves the default", async () => {
    const userId = await createUser();
    const first = await createBrandKit(userId, { name: "A" });
    const second = await createBrandKit(userId, { name: "B" });

    await updateBrandKit(userId, second.id, { isDefault: true });

    const kits = await listBrandKits(userId);
    expect(kits.filter((k) => k.isDefault).map((k) => k.id)).toEqual([second.id]);
    expect(kits.find((k) => k.id === first.id)?.isDefault).toBe(false);
  });

  it("deleting the default promotes the earliest remaining kit", async () => {
    const userId = await createUser();
    const first = await createBrandKit(userId, { name: "A" }); // default
    const second = await createBrandKit(userId, { name: "B" });

    await deleteBrandKit(userId, first.id);

    expect((await getDefaultBrandKit(userId))?.id).toBe(second.id);
    expect(await listBrandKits(userId)).toHaveLength(1);
  });

  it("isConfiguredBrandKit distinguishes a real kit from an empty placeholder", async () => {
    const userId = await createUser();
    const placeholder = await createBrandKit(userId, { name: "My brand" });
    const real = await createBrandKit(userId, {
      name: "Acme",
      companyName: "Acme Inc",
    });
    expect(isConfiguredBrandKit(placeholder)).toBe(false);
    expect(isConfiguredBrandKit(real)).toBe(true);
  });

  it("tenant isolation: a user can't fetch/update/delete another user's kit", async () => {
    const a = await createUser();
    const b = await createUser();
    const kit = await createBrandKit(a, { name: "A-kit" });

    expect(await updateBrandKit(b, kit.id, { name: "hacked" })).toBeNull();
    expect(await deleteBrandKit(b, kit.id)).toBe(false);
    // Still intact for the owner.
    const kits = await listBrandKits(a);
    expect(kits.map((k) => k.name)).toEqual(["A-kit"]);
  });
});
