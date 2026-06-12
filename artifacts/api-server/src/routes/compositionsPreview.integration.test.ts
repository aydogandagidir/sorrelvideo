import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { db, projectsTable } from "@workspace/db";
import app from "../app";
import { createSession } from "../lib/auth";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * GET /api/compositions/:module/preview (module-keyed live preview) + the
 * `?vars=` injection hardening shared with GET /api/projects/:id/composition.
 * Both routes substitute overrides into the composition, and the template
 * layer's escaping does NOT escape quotes — so an un-gated override is reflected
 * XSS. These pin: a known module renders, an unknown module 404s, malformed +
 * injection-unsafe `?vars=` are rejected 400, and the project route applies the
 * same gate.
 */

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "GET /api/compositions/:module/preview",
  () => {
    it("renders a known module's composition HTML for an authed user", async () => {
      const sid = await createSession({ userId: await createFreeUser() });
      const res = await request(app)
        .get("/api/compositions/studio/preview")
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(res.text.length).toBeGreaterThan(0);
    });

    it("404s an unknown module (no silent default-composition fallback)", async () => {
      const sid = await createSession({ userId: await createFreeUser() });
      const res = await request(app)
        .get("/api/compositions/definitely-not-a-module/preview")
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(404);
    });

    it("400s malformed base64 vars", async () => {
      const sid = await createSession({ userId: await createFreeUser() });
      const res = await request(app)
        .get("/api/compositions/studio/preview?vars=not-base64-%%%")
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(400);
    });

    it("400s an injection-unsafe override (reflected-XSS guard)", async () => {
      const sid = await createSession({ userId: await createFreeUser() });
      const vars = b64({ "brand.logoUrl": 'x" onerror="alert(1)' });
      const res = await request(app)
        .get(`/api/compositions/studio/preview?vars=${vars}`)
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(400);
    });

    it("accepts a safe override + a valid resolution", async () => {
      const sid = await createSession({ userId: await createFreeUser() });
      const vars = b64({ "user.headline": "Hello" });
      const res = await request(app)
        .get(`/api/compositions/studio/preview?resolution=landscape&vars=${vars}`)
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(200);
    });
  },
);

describe.runIf(INTEGRATION_AVAILABLE)(
  "GET /api/projects/:id/composition — ?vars= hardening",
  () => {
    it("400s an injection-unsafe ?vars= override on a project the user owns", async () => {
      const userId = await createFreeUser();
      const sid = await createSession({ userId });
      const [project] = await db
        .insert(projectsTable)
        .values({ userId, name: "P", module: "studio" })
        .returning();

      const vars = b64({ "brand.logoUrl": 'x" onerror="alert(1)' });
      const res = await request(app)
        .get(`/api/projects/${project.id}/composition?vars=${vars}`)
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(400);
    });
  },
);
