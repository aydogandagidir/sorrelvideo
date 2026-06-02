import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

describe("POST /api/auth/signup — validation", () => {
  it("rejects an empty body with 400", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects a malformed email with 400", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "not-an-email", password: "supersecret123" });
    expect(res.status).toBe(400);
  });

  it("rejects passwords shorter than 8 characters with 400", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "ok@example.com", password: "short" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login — validation", () => {
  it("rejects an empty body with 400", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/auth/user", () => {
  it("returns {user: null} when no session is present", async () => {
    const res = await request(app).get("/api/auth/user");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
  });
});

describe("GET /api/auth/oauth/providers", () => {
  it("returns 200 with a providers array, matched before the :provider route", async () => {
    const res = await request(app).get("/api/auth/oauth/providers");
    // Not 404: the literal "providers" must NOT be parsed as a provider name
    // by the "/auth/oauth/:provider" route registered just after it.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.providers)).toBe(true);
    expect(res.body.error).toBeUndefined();
  });

  it("lists no providers when none are configured (the default test env)", async () => {
    const res = await request(app).get("/api/auth/oauth/providers");
    // The test env sets no GITHUB_/GOOGLE_OAUTH_* vars, so nothing is offered —
    // which is exactly what makes the SPA hide the buttons.
    expect(res.body.providers).toEqual([]);
  });
});
