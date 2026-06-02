import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

// Mirrors compositions.test.ts: the unit harness imports the real `app`, whose
// authMiddleware resolves sessions against Postgres, so without a DB-backed
// session it exercises the unauthenticated path. The authed flow (capture →
// project, SSRF 400, capture 502) is covered by the live end-to-end test —
// it launches headless Chrome, which doesn't belong in a unit test. The auth
// gate runs before body validation AND before the (expensive) capture, so a
// malformed or unsafe body never reaches the browser here.
describe("POST /api/website-to-video", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .post("/api/website-to-video")
      .send({ url: "https://example.com" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 before validating the body (auth gate is first)", async () => {
    const res = await request(app).post("/api/website-to-video").send({});
    expect(res.status).toBe(401);
  });
});
