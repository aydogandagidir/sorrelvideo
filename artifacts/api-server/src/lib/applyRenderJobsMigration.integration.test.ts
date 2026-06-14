import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  projectsTable,
  renderJobsTable,
  type RenderSettings,
} from "@workspace/db";
import { applyRenderJobsMigration } from "./applyRenderJobsMigration";
import { createRenderJob } from "../services/renderJobsService";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

const settings: RenderSettings = {
  fps: 30,
  quality: "draft",
  format: "mp4",
  resolution: "portrait",
  transparent: false,
  watermark: true,
};

/** Insert a real project for `userId` and return its id (FK parent). */
async function createProject(userId: string): Promise<number> {
  const [project] = await db
    .insert(projectsTable)
    .values({ userId, name: "Test project", module: "studio-default" })
    .returning();
  return project.id;
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("applyRenderJobsMigration", () => {
  it("is safe to run twice (idempotent CREATE TABLE/INDEX/CONSTRAINT)", async () => {
    // drizzle push already created the table + FKs; both calls are no-ops.
    await expect(applyRenderJobsMigration()).resolves.toBeUndefined();
    await expect(applyRenderJobsMigration()).resolves.toBeUndefined();
  });

  it("recreates a missing render_jobs table with an insertable schema", async () => {
    // Simulate the 'forgot to db push' case: drop the table, then let the boot
    // migration recreate it. A row insert through the service must then succeed,
    // proving the DDL matches what the Drizzle schema expects.
    await pool.query("DROP TABLE IF EXISTS render_jobs CASCADE");
    await applyRenderJobsMigration();

    const userId = await createFreeUser();
    const projectId = await createProject(userId);
    const jobId = await createRenderJob({
      projectId,
      userId,
      backend: "inline",
      config: settings,
      format: settings.format,
    });

    const [row] = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.id, jobId));

    // Defaults from the recreated DDL must line up with the schema's defaults.
    expect(row.status).toBe("queued");
    expect(row.progress).toBe(0);
    expect(row.backend).toBe("inline");
    expect(row.cancelRequested).toBe(false);
    expect(row.config).toEqual(settings);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("self-heals the tenant cascade FKs so an orphan render_job is rejected", async () => {
    // The boot migration must ADD the cascade FKs (not just the table), so a row
    // referencing a non-existent project/user can't be written — this is what makes
    // a later `db push` to add the FKs succeed instead of failing on orphans.
    await pool.query("DROP TABLE IF EXISTS render_jobs CASCADE");
    await applyRenderJobsMigration();

    const userId = await createFreeUser();
    // No project with this id exists → the project FK must reject the insert.
    await expect(
      createRenderJob({
        projectId: 999999,
        userId,
        backend: "inline",
        config: settings,
        format: settings.format,
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes a project's render_jobs when the project is deleted", async () => {
    // The FK is ON DELETE CASCADE: removing the parent project must clear its
    // ledger rows so the table can't accumulate orphans.
    const userId = await createFreeUser();
    const projectId = await createProject(userId);
    await createRenderJob({
      projectId,
      userId,
      backend: "inline",
      config: settings,
      format: settings.format,
    });

    await db.delete(projectsTable).where(eq(projectsTable.id, projectId));

    const rows = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.projectId, projectId));
    expect(rows).toHaveLength(0);
  });
});
