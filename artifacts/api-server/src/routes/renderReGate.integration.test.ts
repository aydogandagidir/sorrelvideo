import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import {
  db,
  projectsTable,
  renderJobsTable,
  usersTable,
  type RenderSettings,
} from "@workspace/db";
import { createSession } from "../lib/auth";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * Render re-gate (defense in depth). The Pro/Free render-settings gate runs at
 * PATCH time, but it MUST also run again at render time: a user who saved a Pro
 * config WHILE on Pro and then downgraded (or whose `render_settings` was written
 * directly, bypassing the PATCH gate) must not be able to render that Pro config
 * for free.
 *
 * This drives the real POST /api/projects/:id/render end-to-end for a Free user
 * (no active subscription) whose project carries a Pro-only saved config
 * (`quality: "high"`). The route claims the project (status → rendering),
 * charges the render quota, then `assertRenderSettingsAllowed` rejects — and the
 * route must:
 *   - 403 with `{ reason: "upgrade_required" }` (the shape the UpgradeModal keys on);
 *   - RELEASE the atomic claim back to the prior status (NOT strand "rendering");
 *   - REFUND the quota it charged, so render_count is net-unchanged (a blocked
 *     render is not a consumed render);
 *   - never open a render-job ledger row (the rejection is before enqueue).
 *
 * `enqueueRender` is mocked to a no-op so the accepted-render counterweight test
 * does NOT spawn a real Chrome/FFmpeg render (the inline path is fire-and-forget).
 * The 403 path returns BEFORE enqueue, so that case doesn't depend on the mock —
 * but stubbing the boundary keeps the whole file hermetic regardless.
 */

vi.mock("../lib/renderQueue", async (importActual) => {
  const actual = await importActual<typeof import("../lib/renderQueue")>();
  return {
    ...actual,
    // No-op: the route's claim + quota + re-gate + ledger logic all run for real;
    // only the actual render dispatch is suppressed so no engine process starts.
    enqueueRender: vi.fn(async () => undefined),
  };
});

const app = (await import("../app")).default;

/** Read the persisted render_count for a user. */
async function renderCountOf(userId: string): Promise<number> {
  const [row] = await db
    .select({ renderCount: usersTable.renderCount })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return row.renderCount;
}

const PRO_CONFIG: RenderSettings = {
  fps: 30,
  quality: "high", // Pro-only
  format: "mp4",
  resolution: "portrait",
  transparent: false,
  watermark: true,
};

const FREE_FLOOR_CONFIG: RenderSettings = {
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

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/projects/:id/render — render-settings re-gate (downgraded user)",
  () => {
    it("403s a Free user rendering a saved Pro config, releases the claim, and refunds quota", async () => {
      const userId = await createFreeUser();
      const sid = await createSession({ userId });
      // Insert the project with a Pro config written DIRECTLY (simulating a
      // since-downgraded user / a row that predates the gate). Start from
      // "draft" so we can prove the claim is released back to exactly that.
      const [project] = await db
        .insert(projectsTable)
        .values({
          userId,
          name: "Downgraded Pro config",
          module: "studio",
          status: "draft",
          renderSettings: PRO_CONFIG,
        })
        .returning();

      expect(await renderCountOf(userId)).toBe(0); // baseline

      const res = await request(app)
        .post(`/api/projects/${project.id}/render`)
        .set("Authorization", `Bearer ${sid}`);

      // The 403 the UpgradeModal keys on.
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: expect.stringContaining("Pro"),
        reason: "upgrade_required",
      });

      // The claim was released — the project is NOT stranded in "rendering".
      const [after] = await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.id, project.id));
      expect(after.status).toBe("draft");
      expect(after.renderError).toBeNull();

      // The render quota charged during the claim was refunded — a blocked
      // render must not consume the Free user's monthly allowance.
      expect(await renderCountOf(userId)).toBe(0);

      // The rejection happened before enqueue, so no ledger row was opened.
      const jobs = await db
        .select()
        .from(renderJobsTable)
        .where(eq(renderJobsTable.projectId, project.id));
      expect(jobs).toHaveLength(0);
    });

    it("admits the SAME Free user once the config is back within the Free floor (202)", async () => {
      // Sanity counterweight: the gate blocks ONLY the Pro config, not the user.
      // A draft/standard, mp4, portrait, watermarked config is the Free floor, so
      // the render is accepted (202), the claim sticks as "rendering", a ledger
      // row is opened, and the quota IS charged. (enqueueRender is the no-op mock,
      // so nothing actually renders.)
      const userId = await createFreeUser();
      const sid = await createSession({ userId });
      const [project] = await db
        .insert(projectsTable)
        .values({
          userId,
          name: "Within free floor",
          module: "studio",
          status: "draft",
          renderSettings: FREE_FLOOR_CONFIG,
        })
        .returning();

      const res = await request(app)
        .post(`/api/projects/${project.id}/render`)
        .set("Authorization", `Bearer ${sid}`);

      expect(res.status).toBe(202);
      const [after] = await db
        .select({ status: projectsTable.status })
        .from(projectsTable)
        .where(eq(projectsTable.id, project.id));
      expect(after.status).toBe("rendering");
      // The quota WAS charged this time (the render was genuinely admitted).
      expect(await renderCountOf(userId)).toBe(1);
      // A ledger row was opened (queued) for the admitted attempt.
      const jobs = await db
        .select()
        .from(renderJobsTable)
        .where(eq(renderJobsTable.projectId, project.id));
      expect(jobs).toHaveLength(1);
    });
  },
);
