import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Unit coverage for the `/api/healthz` readiness probe (routes/health.ts).
 *
 * The probe pings Postgres (and Redis when REDIS_URL is set), so we stub
 * `@workspace/db`'s `pool.query` to drive the pass/fail branches without a real
 * database. Redis is left unconfigured (REDIS_URL deleted) for these cases.
 */

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return { ...actual, pool: { query: queryMock } };
});

let app: Express;

beforeEach(async () => {
  delete process.env.REDIS_URL;
  queryMock.mockReset();
  vi.resetModules();
  const healthRouter = (await import("./health")).default;
  app = express();
  app.use("/api", healthRouter);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/healthz", () => {
  it("returns 200 { status: 'ok' } when the database is reachable", async () => {
    queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] });

    const res = await request(app).get("/api/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(queryMock).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns 503 with the failing dependency when the database is down", async () => {
    queryMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app).get("/api/healthz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.checks.database).toBe("error");
    // Redis is unconfigured here, so it must not appear in the report.
    expect(res.body.checks.redis).toBeUndefined();
  });
});
