import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

// Mirrors projects.test.ts: the unit harness imports the real `app`, whose
// authMiddleware resolves sessions against Postgres. Without a DB-backed
// session it can only exercise the unauthenticated path, so the authed 200 +
// non-empty messages case (a deliberately-broken source) is left to an
// integration test. The auth guard runs before body validation, so even a
// malformed body is rejected as 401 here.
describe("POST /api/compositions/lint", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .post("/api/compositions/lint")
      .send({ source: "<html></html>" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 before validating the body (auth gate is first)", async () => {
    const res = await request(app).post("/api/compositions/lint").send({});
    expect(res.status).toBe(401);
  });
});
