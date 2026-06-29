import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

describe("POST /api/smart-trim", () => {
  it("returns 401 when no session is present (before body validation)", async () => {
    const res = await request(app)
      .post("/api/smart-trim")
      .send({ videoObjectPath: "/objects/uploads/abc" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
