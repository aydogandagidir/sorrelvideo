import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

/**
 * Unit tests for the studio file-server routes (M9 Phase 2). Mirrors
 * projects.test.ts: each case asserts the 401-unauthenticated path, which is the
 * one branch reachable WITHOUT the DB-session harness. Several cases deliberately
 * hit a NAMED-WILDCARD route (`/files/*splat`, `/preview/comp/*splat`) so a
 * regressed Express 5 wildcard would surface as a 404 here instead of the
 * expected 401 — that contrast is the wildcard-matching guard.
 *
 * Authenticated flows (write → emit, rename, duplicate, seed-on-open, SSE
 * fan-out) need a real session cookie + DB and are out of scope for this DB-less
 * unit suite; they belong with the api-server integration tier.
 */

describe("GET /api/studio/projects", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).get("/api/studio/projects");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});

describe("GET /api/studio/projects/:id", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).get("/api/studio/projects/1");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/studio/projects/:id/files/*splat (wildcard)", () => {
  it("returns 401 (not 404) for a single-segment path", async () => {
    const res = await request(app).get(
      "/api/studio/projects/1/files/index.html",
    );
    // 401 — not 404 — proves the named wildcard matched and the handler ran.
    expect(res.status).toBe(401);
  });

  it("returns 401 (not 404) for a nested path", async () => {
    const res = await request(app).get(
      "/api/studio/projects/1/files/assets/logo.svg",
    );
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/studio/projects/:id/files/*splat (wildcard)", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .put("/api/studio/projects/1/files/index.html")
      .set("Content-Type", "text/plain")
      .send("<html></html>");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/studio/projects/:id/files/*splat (wildcard)", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .post("/api/studio/projects/1/files/new.html")
      .set("Content-Type", "text/plain")
      .send("<html></html>");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/studio/projects/:id/files/*splat (wildcard)", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).delete(
      "/api/studio/projects/1/files/index.html",
    );
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/studio/projects/:id/files/*splat (wildcard)", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .patch("/api/studio/projects/1/files/index.html")
      .send({ newPath: "renamed.html" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/studio/projects/:id/duplicate-file", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .post("/api/studio/projects/1/duplicate-file")
      .send({ path: "index.html" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/studio/projects/:id/upload", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).post("/api/studio/projects/1/upload");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/studio/projects/:id/preview/comp/*splat (wildcard)", () => {
  it("returns 401 (not 404) for a composition path", async () => {
    const res = await request(app).get(
      "/api/studio/projects/1/preview/comp/index.html",
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/studio/projects/:id/preview (master)", () => {
  it("returns 401 (not 404 — the route must exist) when no session is present", async () => {
    const res = await request(app).get("/api/studio/projects/1/preview");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/studio/projects/:id/preview/*splat (asset wildcard)", () => {
  it("returns 401 (not 404) for an asset path", async () => {
    const res = await request(app).get(
      "/api/studio/projects/1/preview/assets/logo.svg",
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/studio/projects/:id/lint", () => {
  it("returns 401 (not 404 — the route must exist) when no session is present", async () => {
    const res = await request(app).get("/api/studio/projects/1/lint");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/studio/events", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).get("/api/studio/events");
    expect(res.status).toBe(401);
  });
});

// ── Studio 0.6.91 surface (fonts / block catalog / render downloads / stubs) ──
// Same contract as above: every new route must exist (401, never 404) without a
// session. The wildcard cases double as Express 5 named-wildcard guards.

describe("GET /api/studio/fonts (+ /google, /file)", () => {
  it("returns 401 for the installed-fonts list", async () => {
    const res = await request(app).get("/api/studio/fonts");
    expect(res.status).toBe(401);
  });

  it("returns 401 for the google-fonts list", async () => {
    const res = await request(app).get("/api/studio/fonts/google");
    expect(res.status).toBe(401);
  });

  it("returns 401 for the font-file download", async () => {
    const res = await request(app).get("/api/studio/fonts/file?family=Inter");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/studio/registry/blocks", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).get("/api/studio/registry/blocks");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/studio/projects/:id/renders/file/:filename", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).get(
      "/api/studio/projects/1/renders/file/output.mp4",
    );
    expect(res.status).toBe(401);
  });
});

describe("Studio 0.6.91 stub routes (501 surface)", () => {
  it("file-mutations wildcard returns 401 (not 404) unauthenticated", async () => {
    const res = await request(app).post(
      "/api/studio/projects/1/file-mutations/patch-element/index.html",
    );
    expect(res.status).toBe(401);
  });

  it("gsap-mutations wildcard returns 401 (not 404) unauthenticated", async () => {
    const res = await request(app).post(
      "/api/studio/projects/1/gsap-mutations/index.html",
    );
    expect(res.status).toBe(401);
  });

  it("waveform wildcard returns 401 (not 404) unauthenticated", async () => {
    const res = await request(app).get(
      "/api/studio/projects/1/waveform/assets/audio.mp3",
    );
    expect(res.status).toBe(401);
  });

  it("registry/install returns 401 unauthenticated", async () => {
    const res = await request(app).post(
      "/api/studio/projects/1/registry/install",
    );
    expect(res.status).toBe(401);
  });
});
