import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

/**
 * Regression guard for the production CORS origin policy (see app.ts).
 *
 * The CORS `origin` callback is evaluated at module-load time, so we import a
 * FRESH `app` with NODE_ENV=production and a known allow-list (vitest otherwise
 * runs as NODE_ENV=test, where CORS is wide-open and this branch never runs).
 *
 * The bug this locks out: the disallowed-origin branch used to `cb(new Error())`,
 * which makes the `cors` middleware call `next(err)` → a 500. Because Vite tags
 * its emitted module scripts `crossorigin`, the browser fetches even SAME-ORIGIN
 * assets in CORS mode (sending an `Origin` header), so a 500 on a rejected origin
 * white-screened the entire SPA whenever ALLOWED_ORIGINS was unset or even
 * slightly mismatched. A rejected origin must instead resolve WITHOUT an
 * `Access-Control-Allow-Origin` header (the browser still blocks the cross-origin
 * read) and crucially must NOT throw.
 *
 * `/api/healthz` is used as the probe because it is DB-free and unauthenticated,
 * so these assertions isolate the CORS layer (which runs before the router).
 */
describe("production CORS origin policy", () => {
  let app: Express;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOWED_ORIGINS", "https://app.example.com");
    vi.resetModules();
    app = (await import("./app")).default;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("allows requests with no Origin (same-origin nav / curl / server-to-server)", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("grants an allow-listed Origin a matching ACAO + credentials header", async () => {
    const res = await request(app)
      .get("/api/healthz")
      .set("Origin", "https://app.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("rejects a disallowed Origin WITHOUT a 500 and WITHOUT an ACAO header", async () => {
    const res = await request(app)
      .get("/api/healthz")
      .set("Origin", "https://evil.example");
    // The old `cb(new Error())` turned this into a 500 (and broke same-origin
    // asset loads too). It must now pass through cleanly, returning the resource…
    expect(res.status).toBe(200);
    // …but carry NO cross-origin grant, so the browser blocks any cross-origin read.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("preflight (OPTIONS) for a disallowed Origin does not 500", async () => {
    const res = await request(app)
      .options("/api/healthz")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");
    // No grant header, but a clean response — never a thrown 500.
    expect(res.status).not.toBe(500);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
