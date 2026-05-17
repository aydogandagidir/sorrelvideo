import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

describe("POST /api/ai/suggest", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .post("/api/ai/suggest")
      .send({ prompt: "launch our new product" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
