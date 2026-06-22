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
 * A hard render failure splits into TWO audiences. The PROJECT (what the UI
 * shows) gets a short, classified, actionable message. The render_jobs LEDGER
 * (operator-only audit, never surfaced to the client) keeps the RAW engine error
 * so the true cause stays retrievable without log-diving.
 *
 * We mock @hyperframes/producer so no Chrome/FFmpeg runs: executeRenderJob just
 * throws a real-shaped heavy-render failure (a capture timeout — the way a
 * memory-starved / slow box most often dies before it ever reaches the encoder,
 * so there is no moov/ffmpeg signature to key on).
 */

const THROWN = "Navigation timeout of 30000 ms exceeded";

vi.mock("@hyperframes/producer", () => ({
  // Present so renderService's `err instanceof RenderCancelledError` check works.
  RenderCancelledError: class RenderCancelledError extends Error {},
  createRenderJob: (config: unknown) => ({
    id: "job-under-test",
    config,
    status: "queued",
    progress: 0,
    currentStage: "queued",
    createdAt: new Date(),
  }),
  executeRenderJob: async (): Promise<void> => {
    throw new Error(THROWN);
  },
}));

// Thumbnail generation only runs on success; stub it so the failure path never
// touches FFmpeg even if the contract changes.
vi.mock("./thumbnailService", () => ({
  generateThumbnail: vi.fn().mockResolvedValue(null),
  getThumbnailPath: vi.fn(() => "/tmp/none.png"),
}));

const { executeRender } = await import("./renderService");
const { createRenderJob } = await import("./renderJobsService");

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `fail-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

async function createRenderingProject(userId: string): Promise<number> {
  const [row] = await db
    .insert(projectsTable)
    .values({ userId, name: "Fail test", module: "studio", status: "rendering" })
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
  delete process.env.REDIS_URL;
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("executeRender — failure messaging", () => {
  it("shows a classified message on the project, keeps the RAW error in the ledger", async () => {
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

    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    expect(project.status).toBe("failed");
    // The UI message is the friendly, classified guidance — a capture timeout is
    // a resource symptom, so it must NOT fall through to the generic message and
    // must NOT leak the raw Puppeteer string.
    expect(project.renderError).toMatch(
      /shorter length|lower resolution|memory or time/i,
    );
    expect(project.renderError).not.toContain("Navigation timeout");

    const [job] = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.id, renderJobId));
    expect(job.status).toBe("failed");
    // The ledger keeps the RAW technical error verbatim, for operator diagnosis.
    expect(job.error).toBe(THROWN);
  });
});
