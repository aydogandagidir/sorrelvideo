import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, projectsTable, templatesTable } from "@workspace/db";
import app from "../app";
import { createSession } from "../lib/auth";
import { createFreeUser, createProUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * Integration coverage for POST /api/templates/:id/use — the "Use Template"
 * action that mints a project FROM a platform template. This is a paid-product
 * surface (premium templates are Pro-gated) so the regressions worth guarding
 * are: the happy-path 201 creates a userId-scoped project carrying the
 * template's module + id; a Free user hitting a PREMIUM template is 403'd AND no
 * project leaks through; and a registry-slug template lands at its native
 * (landscape) resolution rather than the portrait default.
 *
 * Auth: authMiddleware reads a Bearer token as the session id (lib/auth), so we
 * mint a real session row and send `Authorization: Bearer <sid>`. truncateAll
 * wipes `sessions` too, so the session is created per-test after its user.
 */

/** Insert a platform template (userId null → visible to any authed user). */
async function insertPlatformTemplate(
  overrides: Partial<typeof templatesTable.$inferInsert> = {},
): Promise<typeof templatesTable.$inferSelect> {
  const [row] = await db
    .insert(templatesTable)
    .values({
      userId: null,
      name: "Test Template",
      category: "marketing",
      module: "product-launch",
      thumbnailUrl: "/api/templates/thumbnails/product-launch.png",
      isPremium: false,
      ...overrides,
    })
    .returning();
  return row;
}

async function authFor(userId: string): Promise<string> {
  return createSession({ userId });
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("POST /api/templates/:id/use", () => {
  it("creates a userId-scoped project from a non-premium template (free user)", async () => {
    const userId = await createFreeUser();
    const sid = await authFor(userId);
    const template = await insertPlatformTemplate({
      name: "Launch",
      module: "product-launch",
      isPremium: false,
    });

    const res = await request(app)
      .post(`/api/templates/${template.id}/use`)
      .set("Authorization", `Bearer ${sid}`);

    expect(res.status).toBe(201);
    // The response shape (GetProjectResponse) intentionally omits userId, so
    // tenant-scoping is asserted on the persisted row below.
    expect(res.body.module).toBe(template.module);
    expect(res.body.templateId).toBe(template.id);
    expect(res.body.name).toBe("Launch");

    const rows = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(res.body.id);
    expect(rows[0].module).toBe(template.module);
    expect(rows[0].templateId).toBe(template.id);
  });

  it("403s a free user on a PREMIUM template and creates NO project", async () => {
    const userId = await createFreeUser();
    const sid = await authFor(userId);
    const template = await insertPlatformTemplate({
      name: "Premium",
      module: "product-launch",
      isPremium: true,
    });

    const res = await request(app)
      .post(`/api/templates/${template.id}/use`)
      .set("Authorization", `Bearer ${sid}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Forbidden",
      reason: "upgrade_required",
    });

    // The gate must run BEFORE the insert — no project row may leak through.
    const rows = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("lets a Pro user use a premium template (201)", async () => {
    const userId = await createProUser();
    const sid = await authFor(userId);
    const template = await insertPlatformTemplate({
      name: "Premium",
      module: "product-launch",
      isPremium: true,
    });

    const res = await request(app)
      .post(`/api/templates/${template.id}/use`)
      .set("Authorization", `Bearer ${sid}`);

    expect(res.status).toBe(201);
    const rows = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(res.body.id);
  });

  it("creates a registry-slug project at its native landscape resolution", async () => {
    const userId = await createFreeUser();
    const sid = await authFor(userId);
    // `cinematic-zoom` is a vendored 1920×1080 (landscape), non-premium registry
    // slug — resolutionForModule maps it to "landscape".
    const template = await insertPlatformTemplate({
      name: "Cinematic Zoom",
      module: "cinematic-zoom",
      isPremium: false,
      thumbnailUrl: "/api/templates/thumbnails/cinematic-zoom.png",
    });

    const res = await request(app)
      .post(`/api/templates/${template.id}/use`)
      .set("Authorization", `Bearer ${sid}`);

    expect(res.status).toBe(201);
    expect(res.body.module).toBe("cinematic-zoom");
    expect(res.body.renderSettings).not.toBeNull();
    expect(res.body.renderSettings.resolution).toBe("landscape");
  });
});
