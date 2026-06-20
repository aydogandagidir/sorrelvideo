import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import app from "../app";
import { createSession } from "../lib/auth";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * POST /api/projects/:id/duplicate — clone a project's CONTENT (copy, brand,
 * template, render settings, editor HTML) into a fresh DRAFT. Render outputs and
 * status are NOT copied. Owner-scoped like every other project route.
 */

const RENDER_SETTINGS = {
  fps: 30,
  quality: "standard",
  format: "mp4",
  resolution: "portrait",
  transparent: false,
  watermark: true,
} as const;

async function insertSource(
  userId: string,
): Promise<typeof projectsTable.$inferSelect> {
  const [row] = await db
    .insert(projectsTable)
    .values({
      userId,
      name: "Source",
      module: "studio",
      status: "ready",
      compositionVars: { "user.headline": "Hi", "user.ctaText": "Go" },
      renderSettings: RENDER_SETTINGS,
      // Render outputs that must NOT survive the clone.
      videoUrl: "/renders/1/output.mp4",
      thumbnailUrl: "/renders/1/thumb.png",
      renderError: "old failure text",
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/projects/:id/duplicate",
  () => {
    it("clones content into a fresh draft (new id, name suffix, outputs reset)", async () => {
      const userId = await createFreeUser();
      const sid = await createSession({ userId });
      const source = await insertSource(userId);

      const res = await request(app)
        .post(`/api/projects/${source.id}/duplicate`)
        .set("Authorization", `Bearer ${sid}`);

      expect(res.status).toBe(201);
      expect(res.body.id).not.toBe(source.id);
      expect(res.body.name).toBe("Source (copy)");
      expect(res.body.status).toBe("draft");
      // Content is carried over…
      expect(res.body.module).toBe("studio");
      expect(res.body.compositionVars).toEqual(source.compositionVars);
      expect(res.body.renderSettings).toEqual(RENDER_SETTINGS);
      // …but render outputs are NOT.
      expect(res.body.videoUrl ?? null).toBeNull();
      expect(res.body.thumbnailUrl ?? null).toBeNull();
      expect(res.body.renderError ?? null).toBeNull();

      // The copy is persisted and owned by the requester.
      const rows = await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.userId, userId));
      expect(rows).toHaveLength(2);
    });

    it("403s duplicating another user's project (and creates nothing)", async () => {
      const owner = await createFreeUser();
      const source = await insertSource(owner);
      const otherId = await createFreeUser();
      const sid = await createSession({ userId: otherId });

      const res = await request(app)
        .post(`/api/projects/${source.id}/duplicate`)
        .set("Authorization", `Bearer ${sid}`);

      expect(res.status).toBe(403);
      const rows = await db.select().from(projectsTable);
      expect(rows).toHaveLength(1);
    });

    it("404s a project that does not exist", async () => {
      const userId = await createFreeUser();
      const sid = await createSession({ userId });
      const res = await request(app)
        .post("/api/projects/999999/duplicate")
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(404);
    });

    it("401s without a session", async () => {
      const res = await request(app).post("/api/projects/1/duplicate");
      expect(res.status).toBe(401);
    });
  },
);
