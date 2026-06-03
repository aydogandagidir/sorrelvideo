import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { db, projectsTable, renderJobsTable } from "@workspace/db";
import { createSession } from "../lib/auth";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * Regression guard for the BullMQ re-render race (production Redis path).
 *
 * The bug: `executeRender` flips the PROJECT to ready/draft/failed BEFORE the
 * BullMQ worker fn returns, so the job lock is still held. A back-to-back POST
 * /render then passes the atomic claim (the project is no longer "rendering"),
 * but `enqueueRender`'s `q.remove(jobId)` returns 0 (the prior job is locked),
 * and a follow-up `q.add` with the same jobId is silently dedup-dropped — so the
 * project sticks in "rendering" forever (until the next restart's recovery) and
 * a quota increment is burned.
 *
 * The fix makes `enqueueRender` throw `RenderAlreadyActiveError` on that locked
 * remove(); the route must then RELEASE the claim and 409, never leaving the
 * project stranded in "rendering".
 *
 * We can't spin a real Redis broker in the inline-mode test harness, so we mock
 * the queue boundary to reproduce the exact symptom: the second back-to-back
 * enqueue throws `RenderAlreadyActiveError` (as the real bullmq branch now does
 * when remove() returns 0). Everything else — the route, the atomic claim, the
 * ledger, the DB — is real and driven end-to-end.
 */

const h = vi.hoisted(() => ({
  // Real RenderAlreadyActiveError, re-exported by the mock below so the route's
  // `instanceof` check matches.
  RenderAlreadyActiveError: class extends Error {
    constructor(projectId: number) {
      super(`A render for project ${projectId} is still finishing`);
      this.name = "RenderAlreadyActiveError";
    }
  },
  enqueueCalls: 0,
}));

vi.mock("../lib/renderQueue", async (importActual) => {
  const actual = await importActual<typeof import("../lib/renderQueue")>();
  return {
    ...actual,
    // First enqueue succeeds (no-op — we don't actually render). The second,
    // back-to-back, simulates the prior job still holding its lock: remove()
    // returned 0, so the real bullmq branch throws RenderAlreadyActiveError.
    enqueueRender: vi.fn(async (projectId: number) => {
      h.enqueueCalls += 1;
      if (h.enqueueCalls >= 2) {
        throw new h.RenderAlreadyActiveError(projectId);
      }
    }),
    RenderAlreadyActiveError: h.RenderAlreadyActiveError,
  };
});

const app = (await import("../app")).default;

beforeEach(async () => {
  h.enqueueCalls = 0;
  delete process.env.REDIS_URL;
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/projects/:id/render — back-to-back re-render race",
  () => {
    it("releases the claim and 409s (never strands 'rendering') when the prior job is still locked", async () => {
      const userId = await createFreeUser();
      const sid = await createSession({ userId });
      const [project] = await db
        .insert(projectsTable)
        .values({
          userId,
          name: "Re-render race",
          module: "studio",
          status: "draft",
        })
        .returning();

      // First render claims the project (status → rendering) and enqueues OK.
      const first = await request(app)
        .post(`/api/projects/${project.id}/render`)
        .set("Authorization", `Bearer ${sid}`);
      expect(first.status).toBe(202);

      // Simulate the previous render having flipped the project back to a
      // finished state (its worker fn returned to ready/draft/failed) while its
      // BullMQ job lock is, momentarily, still held — exactly the race window.
      await db
        .update(projectsTable)
        .set({ status: "ready" })
        .where(eq(projectsTable.id, project.id));

      // Second, back-to-back render: wins the atomic claim (project is "ready"),
      // but the prior job is still locked → enqueue throws.
      const second = await request(app)
        .post(`/api/projects/${project.id}/render`)
        .set("Authorization", `Bearer ${sid}`);

      // The fix: a clean 409, NOT a 503 and NOT a stranded "rendering".
      expect(second.status).toBe(409);

      const [after] = await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.id, project.id));
      // The claim was released back to the prior status — the project is
      // re-renderable, never stuck in "rendering".
      expect(after.status).toBe("ready");

      // The second attempt's ledger row was resolved (cancelled), not left
      // hanging in "queued" and not marked a hard "failed".
      const jobs = await db
        .select()
        .from(renderJobsTable)
        .where(eq(renderJobsTable.projectId, project.id));
      const statuses = jobs.map((j) => j.status).sort();
      // Two attempts total; neither is a hard failure, and at least one was
      // cancelled (the dropped second attempt). The first stays "queued" here
      // because the mocked enqueue never advanced it.
      expect(statuses).not.toContain("failed");
      expect(statuses).toContain("cancelled");
    });
  },
);
