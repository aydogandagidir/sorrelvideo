import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { db, projectsTable } from "@workspace/db";
import { createSession } from "../lib/auth";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * A failing render-job ledger INSERT must never strand a project in
 * "rendering". POST /api/projects/:id/render claims the project (status →
 * rendering) BEFORE opening the ledger row; if that INSERT throws (e.g. the
 * render_jobs table is missing), the route must release the claim back to the
 * prior status and 503 — not leave the project permanently un-renderable.
 *
 * We force createRenderJob to throw (keeping every other export real) and drive
 * the real route end-to-end against the test DB.
 */

const h = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("../services/renderJobsService", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/renderJobsService")>();
  return {
    ...actual,
    createRenderJob: vi.fn(async (input) => {
      if (h.shouldThrow) {
        throw new Error("simulated render_jobs INSERT failure");
      }
      return actual.createRenderJob(input);
    }),
  };
});

const app = (await import("../app")).default;

beforeEach(async () => {
  h.shouldThrow = false;
  delete process.env.REDIS_URL;
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/projects/:id/render — ledger-insert failure",
  () => {
    it("releases the 'rendering' claim and 503s when the ledger INSERT fails", async () => {
      const userId = await createFreeUser();
      const sid = await createSession({ userId });
      const [project] = await db
        .insert(projectsTable)
        .values({ userId, name: "Release test", module: "studio", status: "draft" })
        .returning();

      h.shouldThrow = true;

      const res = await request(app)
        .post(`/api/projects/${project.id}/render`)
        .set("Authorization", `Bearer ${sid}`);

      expect(res.status).toBe(503);

      // The claim was released — the project is back to its prior status, NOT
      // stranded in "rendering".
      const [after] = await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.id, project.id));
      expect(after.status).toBe("draft");
    });
  },
);
