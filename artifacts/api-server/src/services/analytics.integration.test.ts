/**
 * Integration coverage for analyticsService.getAnalyticsOverview — the SQL
 * aggregation over render_jobs (joined to projects) plus the multi-tenant
 * isolation invariant (one tenant must never see another's render metrics).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db, projectsTable, renderJobsTable, usersTable } from "@workspace/db";
import { getAnalyticsOverview } from "./analyticsService";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

async function createUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `an-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

async function createProject(userId: string, module: string): Promise<number> {
  const [row] = await db
    .insert(projectsTable)
    .values({ userId, name: `Proj ${module}`, module })
    .returning();
  return row.id;
}

async function addJob(input: {
  userId: string;
  projectId: number;
  status: string;
  format?: string;
}): Promise<void> {
  await db.insert(renderJobsTable).values({
    userId: input.userId,
    projectId: input.projectId,
    status: input.status,
    format: input.format ?? null,
  });
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "analyticsService.getAnalyticsOverview",
  () => {
    it("aggregates totals, success rate, formats, top templates and recent renders", async () => {
      const userId = await createUser();
      const projectId = await createProject(userId, "studio-default");

      // 3 ready (mp4), 1 failed (mp4), 1 cancelled (webm), 1 queued (mp4).
      await addJob({ userId, projectId, status: "ready", format: "mp4" });
      await addJob({ userId, projectId, status: "ready", format: "mp4" });
      await addJob({ userId, projectId, status: "ready", format: "mp4" });
      await addJob({ userId, projectId, status: "failed", format: "mp4" });
      await addJob({ userId, projectId, status: "cancelled", format: "webm" });
      await addJob({ userId, projectId, status: "queued", format: "mp4" });

      const overview = await getAnalyticsOverview(userId);

      expect(overview.totals.totalRenders).toBe(6);
      expect(overview.totals.succeeded).toBe(3);
      expect(overview.totals.failed).toBe(1);
      expect(overview.totals.cancelled).toBe(1);
      expect(overview.totals.inProgress).toBe(1); // queued
      // 3 / (3 + 1) completed = 0.75.
      expect(overview.totals.successRate).toBeCloseTo(0.75, 5);

      // Formats ordered by count desc: mp4 (5) before webm (1).
      expect(overview.formats).toEqual([
        { format: "mp4", count: 5 },
        { format: "webm", count: 1 },
      ]);

      // Single project → one template module with all 6 renders.
      expect(overview.topTemplates).toEqual([
        { module: "studio-default", count: 6 },
      ]);

      // Recent renders join the project name/module; capped + newest first.
      expect(overview.recentRenders.length).toBe(6);
      expect(overview.recentRenders[0].projectName).toBe("Proj studio-default");
      expect(overview.recentRenders[0].module).toBe("studio-default");

      // The activity axis always spans the full 30-day window, and every job we
      // inserted lands inside it (created "now").
      expect(overview.activity.length).toBe(30);
      const activityTotal = overview.activity.reduce((s, d) => s + d.total, 0);
      expect(activityTotal).toBe(6);
    });

    it("returns an empty overview (null success rate) when the user has no renders", async () => {
      const userId = await createUser();

      const overview = await getAnalyticsOverview(userId);

      expect(overview.totals.totalRenders).toBe(0);
      expect(overview.totals.successRate).toBeNull();
      expect(overview.formats).toEqual([]);
      expect(overview.topTemplates).toEqual([]);
      expect(overview.recentRenders).toEqual([]);
      // Zero-filled axis is still the full window.
      expect(overview.activity.length).toBe(30);
    });

    it("scopes strictly to the owner — another tenant's renders are excluded", async () => {
      const owner = await createUser();
      const ownerProject = await createProject(owner, "studio-default");
      await addJob({
        userId: owner,
        projectId: ownerProject,
        status: "ready",
        format: "mp4",
      });
      await addJob({
        userId: owner,
        projectId: ownerProject,
        status: "ready",
        format: "mp4",
      });

      // A second tenant with far more activity must not bleed into the owner's view.
      const other = await createUser();
      const otherProject = await createProject(other, "website-showcase");
      for (let i = 0; i < 5; i++) {
        await addJob({
          userId: other,
          projectId: otherProject,
          status: "ready",
          format: "webm",
        });
      }

      const overview = await getAnalyticsOverview(owner);

      expect(overview.totals.totalRenders).toBe(2);
      expect(overview.totals.succeeded).toBe(2);
      expect(overview.formats).toEqual([{ format: "mp4", count: 2 }]);
      expect(overview.topTemplates).toEqual([
        { module: "studio-default", count: 2 },
      ]);
      expect(
        overview.recentRenders.every((r) => r.module === "studio-default"),
      ).toBe(true);
    });
  },
);
