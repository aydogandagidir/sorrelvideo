import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  renderJobsTable,
  usersTable,
  type RenderSettings,
} from "@workspace/db";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * Cancellation must actually abort the engine. The cancel route flags
 * `render_jobs.cancelRequested`; executeRender hands an AbortSignal to
 * executeRenderJob and polls the flag in the progress callback, aborting the
 * controller when set. The engine then throws RenderCancelledError, which
 * executeRender treats as a rollback-to-draft (not a failure).
 *
 * We mock @hyperframes/producer so no Chrome/FFmpeg runs: the fake
 * executeRenderJob drives the progress callback (which performs the cancel
 * poll) and throws a real-shaped RenderCancelledError the moment its abort
 * signal fires — exactly the contract the engine documents.
 */

// A real class so renderService's `err instanceof RenderCancelledError` matches.
class RenderCancelledError extends Error {
  reason: "user_cancelled" | "timeout" | "aborted";
  constructor(
    message = "Render cancelled",
    reason: "user_cancelled" | "timeout" | "aborted" = "aborted",
  ) {
    super(message);
    this.name = "RenderCancelledError";
    this.reason = reason;
  }
}

const h = vi.hoisted(() => ({
  // Tracks whether the fake engine actually observed an abort.
  aborted: false,
}));

vi.mock("@hyperframes/producer", () => ({
  RenderCancelledError,
  createRenderJob: (config: unknown) => ({
    id: "job-under-test",
    config,
    status: "queued",
    progress: 0,
    currentStage: "queued",
    createdAt: new Date(),
  }),
  // Drive the progress callback until the signal aborts, then throw — mirroring
  // the engine honoring its abortSignal. A bounded loop avoids hanging the test
  // if the cancel poll never aborts (the assertion below would then fail).
  executeRenderJob: async (
    job: { progress: number },
    _dir: string,
    _outputPath: string,
    onProgress?: (j: { progress: number }, msg: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (abortSignal?.aborted) {
        h.aborted = true;
        throw new RenderCancelledError();
      }
      job.progress = Math.min(1, (i + 1) / 200);
      onProgress?.(job, `frame ${i}`);
      // Yield so the async cancel poll (isCancelRequested → abort) can resolve
      // before the next iteration checks the signal.
      await new Promise((r) => setImmediate(r));
    }
  },
}));

// Thumbnail generation only runs on success; stub it so a cancel path never
// touches FFmpeg even if the contract changes.
vi.mock("./thumbnailService", () => ({
  generateThumbnail: vi.fn().mockResolvedValue(null),
  getThumbnailPath: vi.fn(() => "/tmp/none.png"),
}));

const { executeRender } = await import("./renderService");
const { createRenderJob, requestCancel } = await import("./renderJobsService");

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `cancel-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

async function createRenderingProject(userId: string): Promise<number> {
  const [row] = await db
    .insert(projectsTable)
    .values({ userId, name: "Cancel test", module: "studio", status: "rendering" })
    .returning();
  return row.id;
}

const settings: RenderSettings = {
  fps: 30,
  quality: "draft",
  format: "mp4",
  resolution: "portrait",
  transparent: false,
  watermark: true,
};

beforeEach(async () => {
  h.aborted = false;
  delete process.env.REDIS_URL;
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("executeRender — cancellation", () => {
  it("aborts mid-render: job → 'cancelled', project → 'draft'", async () => {
    const userId = await createUser();
    const projectId = await createRenderingProject(userId);
    const renderJobId = await createRenderJob({
      projectId,
      userId,
      backend: "inline",
      config: settings,
      format: settings.format,
    });

    // Flag the cancel BEFORE the render runs; the first progress poll observes
    // it and aborts the controller, just like a cancel arriving mid-render.
    await requestCancel(renderJobId, userId);

    await executeRender(projectId, "studio", null, renderJobId);

    // The fake engine actually saw the abort (not just an early return).
    expect(h.aborted).toBe(true);

    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    expect(project.status).toBe("draft");
    // Cancellation is not a failure — no renderError surfaced to the UI.
    expect(project.renderError).toBeNull();

    const [job] = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.id, renderJobId));
    expect(job.status).toBe("cancelled");
  });

  it("runs to completion (job → 'ready', project → 'ready') when never cancelled", async () => {
    const userId = await createUser();
    const projectId = await createRenderingProject(userId);
    const renderJobId = await createRenderJob({
      projectId,
      userId,
      backend: "inline",
      config: settings,
      format: settings.format,
    });

    await executeRender(projectId, "studio", null, renderJobId);

    expect(h.aborted).toBe(false);

    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    expect(project.status).toBe("ready");

    const [job] = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.id, renderJobId));
    expect(job.status).toBe("ready");
    // NB: progress is intentionally not asserted to be exactly 100. The
    // per-tick markProgress writes are fire-and-forget (`void`), so a late one
    // can land after markReady's progress=100 — a benign race that exists in
    // production too. The authoritative signal is status === "ready".
  });
});
