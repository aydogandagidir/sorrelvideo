import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

describe("GET /api/projects", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});

describe("POST /api/projects", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .post("/api/projects")
      .send({ name: "x", module: "studio" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/projects/:id/render", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).post("/api/projects/1/render");
    expect(res.status).toBe(401);
  });
});
