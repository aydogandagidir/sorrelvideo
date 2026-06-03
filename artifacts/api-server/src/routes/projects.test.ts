import { describe, expect, it } from "vitest";
import request from "supertest";
import { UpdateProjectBody } from "@workspace/api-zod";
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

describe("POST /api/projects/:id/render/cancel", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).post("/api/projects/1/render/cancel");
    expect(res.status).toBe(401);
  });
});

// The generic PATCH must never let an owner write server-managed render
// lifecycle/denormalized state. The route does `db.update().set(parsed.data)`,
// so the contract is enforced by UpdateProjectBody: editable fields pass, the
// server-managed fields are stripped (the schema is non-strict, so unknown keys
// are dropped — they never reach the row). Lifecycle changes only via the
// render/claim/cancel/recovery paths.
describe("UpdateProjectBody (generic PATCH /projects/:id contract)", () => {
  it("accepts user-editable fields", () => {
    const parsed = UpdateProjectBody.parse({
      name: "Renamed",
      description: "desc",
      compositionVars: { headline: "Hi" },
    });
    expect(parsed).toEqual({
      name: "Renamed",
      description: "desc",
      compositionVars: { headline: "Hi" },
    });
  });

  it("strips server-managed lifecycle/denormalized fields", () => {
    const parsed = UpdateProjectBody.parse({
      name: "Renamed",
      // None of these may pass through to the row — they belong to the render
      // state machine, not the user.
      status: "rendering",
      videoUrl: "https://evil.example/owned.mp4",
      thumbnailUrl: "https://evil.example/owned.png",
      renderError: "spoofed",
      duration: 999,
    });
    expect(parsed).toEqual({ name: "Renamed" });
    expect(parsed).not.toHaveProperty("status");
    expect(parsed).not.toHaveProperty("videoUrl");
    expect(parsed).not.toHaveProperty("thumbnailUrl");
  });
});
