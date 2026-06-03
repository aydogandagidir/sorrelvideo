import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, renderJobsTable, type RenderSettings } from "@workspace/db";
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

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("applyRenderJobsMigration", () => {
  it("is safe to run twice (idempotent CREATE TABLE/INDEX IF NOT EXISTS)", async () => {
    // drizzle push already created the table; both calls are no-ops.
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
    const jobId = await createRenderJob({
      projectId: 1,
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
});
