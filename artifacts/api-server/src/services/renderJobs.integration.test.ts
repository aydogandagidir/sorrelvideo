import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  renderJobsTable,
  usersTable,
  type RenderSettings,
} from "@workspace/db";
import {
  createRenderJob,
  getLatestJobForProject,
  isCancelRequested,
  markProgress,
  markReady,
  markRendering,
  requestCancel,
} from "./renderJobsService";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `rj-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

async function createProject(userId: string): Promise<number> {
  const [row] = await db
    .insert(projectsTable)
    .values({ userId, name: "Render-job test", module: "studio" })
    .returning();
  return row.id;
}

const settings: RenderSettings = {
  fps: 30,
  quality: "standard",
  format: "mp4",
  resolution: "portrait",
  transparent: false,
  watermark: true,
};

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("renderJobsService", () => {
  it("persists the queued → rendering → progress → ready lifecycle", async () => {
    const userId = await createUser();
    const projectId = await createProject(userId);

    const jobId = await createRenderJob({
      projectId,
      userId,
      backend: "inline",
      config: settings,
      format: settings.format,
    });
    expect(typeof jobId).toBe("string");
    expect(jobId.length).toBeGreaterThan(0);

    const [queued] = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.id, jobId));
    expect(queued.status).toBe("queued");
    expect(queued.progress).toBe(0);
    expect(queued.backend).toBe("inline");
    expect(queued.format).toBe("mp4");
    expect(queued.config).toEqual(settings);
    expect(queued.cancelRequested).toBe(false);

    await markRendering(jobId);
    await markProgress(jobId, 50);

    const [mid] = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.id, jobId));
    expect(mid.status).toBe("rendering");
    expect(mid.progress).toBe(50);

    await markReady(jobId, { duration: 12, outputPath: "/tmp/output.mp4" });

    const [done] = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.id, jobId));
    expect(done.status).toBe("ready");
    expect(done.progress).toBe(100);
    expect(done.outputPath).toBe("/tmp/output.mp4");
  });

  it("requestCancel sets cancelRequested and isCancelRequested reflects it", async () => {
    const userId = await createUser();
    const projectId = await createProject(userId);
    const jobId = await createRenderJob({
      projectId,
      userId,
      backend: "inline",
      config: settings,
    });

    expect(await isCancelRequested(jobId)).toBe(false);

    const flagged = await requestCancel(jobId, userId);
    expect(flagged).toBe(true);
    expect(await isCancelRequested(jobId)).toBe(true);

    // A different user cannot cancel the job (userId-scoped).
    const otherUser = await createUser();
    const otherJob = await createRenderJob({
      projectId,
      userId,
      backend: "inline",
      config: settings,
    });
    const blocked = await requestCancel(otherJob, otherUser);
    expect(blocked).toBe(false);
    expect(await isCancelRequested(otherJob)).toBe(false);
  });

  it("getLatestJobForProject returns the newest job", async () => {
    const userId = await createUser();
    const projectId = await createProject(userId);

    const firstId = await createRenderJob({
      projectId,
      userId,
      backend: "inline",
      config: settings,
    });
    // Nudge createdAt so ordering is deterministic even at sub-ms resolution.
    await db
      .update(renderJobsTable)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(renderJobsTable.id, firstId));

    const secondId = await createRenderJob({
      projectId,
      userId,
      backend: "bullmq",
      config: settings,
    });

    const latest = await getLatestJobForProject(projectId);
    expect(latest?.id).toBe(secondId);
    expect(latest?.backend).toBe("bullmq");

    // Unknown project → undefined.
    expect(await getLatestJobForProject(999_999)).toBeUndefined();
  });
});
