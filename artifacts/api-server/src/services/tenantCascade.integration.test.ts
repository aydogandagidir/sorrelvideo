import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  brandKitTable,
  db,
  projectsTable,
  renderJobsTable,
  usersTable,
  type RenderSettings,
} from "@workspace/db";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * Referential integrity + retention for the tenant tables. These guard the four
 * ON DELETE CASCADE FKs added to lib/db/src/schema (projects.userId,
 * brand_kit.userId, render_jobs.userId, render_jobs.projectId): deleting a
 * project or a user must not leave orphaned rows behind — render_jobs in
 * particular is scanned on every distributed-quota check and boot recovery.
 *
 * The FKs only exist once `pnpm --filter @workspace/db run push` has applied the
 * schema; the test harness does exactly that (push-force in globalSetup), so
 * these assertions also prove the schema actually carries the constraints.
 */

const settings: RenderSettings = {
  fps: 30,
  quality: "draft",
  format: "mp4",
  resolution: "portrait",
  transparent: false,
  watermark: true,
};

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `cascade-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

async function createProject(userId: string): Promise<number> {
  const [row] = await db
    .insert(projectsTable)
    .values({ userId, name: "Cascade test", module: "studio" })
    .returning();
  return row.id;
}

async function createRenderJobRow(
  projectId: number,
  userId: string,
): Promise<string> {
  const [row] = await db
    .insert(renderJobsTable)
    .values({ projectId, userId, backend: "inline", config: settings })
    .returning({ id: renderJobsTable.id });
  return row.id;
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("tenant cascade FKs", () => {
  it("deleting a project cascades its render_jobs but keeps the user + other projects", async () => {
    const userId = await createUser();
    const doomed = await createProject(userId);
    const kept = await createProject(userId);
    const doomedJob = await createRenderJobRow(doomed, userId);
    const keptJob = await createRenderJobRow(kept, userId);

    await db.delete(projectsTable).where(eq(projectsTable.id, doomed));

    const jobs = await db.select().from(renderJobsTable);
    const jobIds = jobs.map((j) => j.id);
    expect(jobIds).not.toContain(doomedJob);
    expect(jobIds).toContain(keptJob);

    const projects = await db.select().from(projectsTable);
    expect(projects.map((p) => p.id)).toEqual([kept]);

    // The owning user is untouched by a project delete.
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(user).toBeDefined();
  });

  it("deleting a user cascades projects, brand_kit, and render_jobs", async () => {
    const userId = await createUser();
    const projectId = await createProject(userId);
    await createRenderJobRow(projectId, userId);
    await db.insert(brandKitTable).values({ userId, companyName: "Acme" });

    await db.delete(usersTable).where(eq(usersTable.id, userId));

    expect(await db.select().from(projectsTable)).toHaveLength(0);
    expect(await db.select().from(renderJobsTable)).toHaveLength(0);
    expect(await db.select().from(brandKitTable)).toHaveLength(0);
  });

  it("rejects a render_job referencing a non-existent project (FK enforced)", async () => {
    const userId = await createUser();
    await expect(createRenderJobRow(999_999, userId)).rejects.toThrow();
  });

  it("rejects a render_job referencing a non-existent user (FK enforced)", async () => {
    const userId = await createUser();
    const projectId = await createProject(userId);
    await expect(
      db
        .insert(renderJobsTable)
        .values({
          projectId,
          userId: "no-such-user",
          backend: "inline",
          config: settings,
        }),
    ).rejects.toThrow();
  });
});
