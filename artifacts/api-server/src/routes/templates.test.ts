import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

// The self-hosted template thumbnail route is PUBLIC and DB-less, so the unit
// harness (which can't mint a Postgres-backed session) can exercise it fully —
// unlike the auth-gated template routes, which only reach their 401 path here.
//
// These also guard the two easy-to-break invariants:
//   1. `/templates/thumbnails/:slug` must be matched BEFORE `/templates/:id`,
//      else "thumbnails" is parsed as an id (→ 400) and the poster 404s.
//   2. `:slug` is an allow-list off the vendored manifest, so an unknown or
//      traversal-y value can't read an arbitrary file off disk.
describe("GET /api/templates/thumbnails/:slug", () => {
  it("serves a known template's poster PNG (with the .png suffix)", async () => {
    const res = await request(app).get(
      "/api/templates/thumbnails/data-chart.png",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    // supertest buffers an image/* body into a Buffer; assert it's a real,
    // non-trivial PNG (magic bytes + well above a "blank frame" size).
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(3000);
    expect(res.body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("also resolves the slug without the .png suffix", async () => {
    const res = await request(app).get("/api/templates/thumbnails/data-chart");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("404s for a slug that is not a vendored template (allow-list)", async () => {
    const res = await request(app).get(
      "/api/templates/thumbnails/not-a-real-template.png",
    );
    expect(res.status).toBe(404);
  });

  it("does not let a traversal slug escape the thumbnails dir", async () => {
    // Encoded so it reaches the handler as a single :slug segment rather than
    // being collapsed by path normalization into a different route.
    const res = await request(app).get(
      "/api/templates/thumbnails/..%2f..%2fpackage.json",
    );
    expect(res.status).toBe(404);
  });

  it("is matched before /templates/:id (no 401/400 from the id route)", async () => {
    // If ordering regressed, this would hit `GET /templates/:id` → 401
    // (unauthenticated) or 400 (NaN id) instead of the public poster.
    const res = await request(app).get("/api/templates/thumbnails/world-map");
    expect(res.status).toBe(200);
  });
});

// Mirrors compositions.test.ts / projects.test.ts: the unit harness imports the
// real `app`, whose authMiddleware resolves sessions against Postgres. Without a
// DB-backed session it can only exercise the unauthenticated path, so the authed
// 201 + premium-gate + landscape-resolution cases live in
// templates.integration.test.ts. The auth guard runs before id validation, so
// even a non-numeric :id is rejected as 401 here.
describe("POST /api/templates/:id/use", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).post("/api/templates/1/use");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 before validating the id (auth gate is first)", async () => {
    const res = await request(app).post("/api/templates/not-a-number/use");
    expect(res.status).toBe(401);
  });
});
