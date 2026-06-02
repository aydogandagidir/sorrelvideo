import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  usersTable,
  stripeSubscriptionsTable,
  type RenderSettings,
} from "@workspace/db";
import {
  resolveSettings,
  assertRenderSettingsAllowed,
  RenderSettingsUpgradeError,
} from "./renderSettingsService";
import { getUserPlan } from "./billingService";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

async function createFreeUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `free-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

async function createProUser(): Promise<{ userId: string; customerId: string }> {
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
  return { userId: row.id, customerId };
}

async function createProject(userId: string): Promise<number> {
  const [row] = await db
    .insert(projectsTable)
    .values({ userId, name: "Test project", module: "studio" })
    .returning();
  return row.id;
}

const proSettings: RenderSettings = {
  fps: 60,
  quality: "high",
  format: "webm",
  resolution: "landscape-4k",
  transparent: true,
  watermark: false,
};

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("renderSettings persistence + gating", () => {
  it("round-trips a full RenderSettings object through the jsonb column", async () => {
    const { userId } = await createProUser();
    const id = await createProject(userId);

    await db
      .update(projectsTable)
      .set({ renderSettings: proSettings })
      .where(eq(projectsTable.id, id));

    const [row] = await db
      .select({ rs: projectsTable.renderSettings })
      .from(projectsTable)
      .where(eq(projectsTable.id, id));

    expect(row.rs).toEqual(proSettings);
  });

  it("defaults to null on a fresh project (legacy render output preserved)", async () => {
    const userId = await createFreeUser();
    const id = await createProject(userId);
    const [row] = await db
      .select({ rs: projectsTable.renderSettings })
      .from(projectsTable)
      .where(eq(projectsTable.id, id));
    expect(row.rs).toBeNull();
  });

  it("gates Pro-only settings for a free user (real getUserPlan)", async () => {
    const userId = await createFreeUser();
    const [u] = await db
      .select({ cid: usersTable.stripeCustomerId })
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    const plan = await getUserPlan(u.cid);
    expect(plan).toBe("free");
    expect(() =>
      assertRenderSettingsAllowed(resolveSettings({ quality: "high" }), plan),
    ).toThrow(RenderSettingsUpgradeError);
  });

  it("persists an allowed Free config and a merged patch", async () => {
    const userId = await createFreeUser();
    const id = await createProject(userId);
    const [u] = await db
      .select({ cid: usersTable.stripeCustomerId })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    const plan = await getUserPlan(u.cid);

    // First save: standard quality at 24fps (both Free-allowed).
    let merged = resolveSettings({ quality: "standard", fps: 24 });
    assertRenderSettingsAllowed(merged, plan);
    await db
      .update(projectsTable)
      .set({ renderSettings: merged })
      .where(eq(projectsTable.id, id));

    // Patch only resolution; the merge must preserve the prior quality/fps.
    const [mid] = await db
      .select({ rs: projectsTable.renderSettings })
      .from(projectsTable)
      .where(eq(projectsTable.id, id));
    merged = resolveSettings({ ...(mid.rs ?? {}), resolution: "square" });
    assertRenderSettingsAllowed(merged, plan);
    await db
      .update(projectsTable)
      .set({ renderSettings: merged })
      .where(eq(projectsTable.id, id));

    const [row] = await db
      .select({ rs: projectsTable.renderSettings })
      .from(projectsTable)
      .where(eq(projectsTable.id, id));
    expect(row.rs?.quality).toBe("standard");
    expect(row.rs?.fps).toBe(24);
    expect(row.rs?.resolution).toBe("square");
  });

  it("allows every Pro-only setting for a pro user (real getUserPlan)", async () => {
    const { customerId } = await createProUser();
    const plan = await getUserPlan(customerId);
    expect(plan).toBe("pro");
    expect(() => assertRenderSettingsAllowed(proSettings, plan)).not.toThrow();
  });
});
