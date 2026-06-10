import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";
import { truncateAll } from "./integration";
import { INTEGRATION_AVAILABLE } from "./setup";

/**
 * HTTP end-to-end tests: drive the REAL Express app (the same router stack a
 * browser hits) through supertest against the testcontainer Postgres. Covers the
 * critical user journeys end-to-end — auth, projects, multi-tenant isolation, the
 * render-settings Pro gate, and the Track F avatar endpoints.
 *
 * Each signup uses a DISTINCT X-Forwarded-For so the per-IP signup limiter
 * (3/hour) doesn't throttle the suite — `trust proxy = 1` makes that header the
 * keyed client ip. A browser-level Playwright smoke (rendering an MP4) is a
 * heavier, separate follow-up; this exercises the whole API surface deterministically.
 */

const PASSWORD = "supersecret123";

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.10.0.${ipCounter}`;
}

async function signup(email: string) {
  const agent = request.agent(app);
  const ip = nextIp();
  const res = await agent
    .post("/api/auth/signup")
    .set("X-Forwarded-For", ip)
    .send({ email, password: PASSWORD });
  return { agent, ip, res };
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("E2E — auth journey", () => {
  it("signup → authed → logout → null → login → authed", async () => {
    const email = "journey@test.local";
    const { agent, ip, res } = await signup(email);
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);

    const me = await agent.get("/api/auth/user");
    expect(me.status).toBe(200);
    expect(me.body.user?.email).toBe(email);

    const out = await agent.post("/api/auth/logout");
    expect(out.status).toBe(200);

    const afterLogout = await agent.get("/api/auth/user");
    expect(afterLogout.body.user).toBeNull();

    const login = await agent
      .post("/api/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(200);

    const me2 = await agent.get("/api/auth/user");
    expect(me2.body.user?.email).toBe(email);
  });

  it("rejects a duplicate signup with 409", async () => {
    const email = "dupe@test.local";
    await signup(email);
    const { res } = await signup(email);
    expect(res.status).toBe(409);
  });

  it("rejects a wrong password with 401", async () => {
    const email = "wrongpw@test.local";
    const { agent, ip } = await signup(email);
    await agent.post("/api/auth/logout");
    const login = await agent
      .post("/api/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email, password: "not-the-password" });
    expect(login.status).toBe(401);
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("E2E — projects + tenant isolation", () => {
  it("creates, lists and fetches a project for its owner", async () => {
    const { agent } = await signup("owner@test.local");

    const create = await agent
      .post("/api/projects")
      .send({ name: "E2E Project", module: "studio" });
    expect(create.status).toBe(201);
    const projectId = create.body.id as number;
    expect(typeof projectId).toBe("number");

    const list = await agent.get("/api/projects");
    expect(list.status).toBe(200);
    expect(
      (list.body as Array<{ id: number }>).some((p) => p.id === projectId),
    ).toBe(true);

    const get = await agent.get(`/api/projects/${projectId}`);
    expect(get.status).toBe(200);
    expect(get.body.name).toBe("E2E Project");
  });

  it("isolates a project across tenants (403 to a non-owner)", async () => {
    const a = await signup("tenant-a@test.local");
    const create = await a.agent
      .post("/api/projects")
      .send({ name: "Private", module: "studio" });
    const projectId = create.body.id as number;

    const b = await signup("tenant-b@test.local");
    const cross = await b.agent.get(`/api/projects/${projectId}`);
    // Documented multi-tenant invariant: an authenticated NON-owner gets 403
    // (404 is reserved for a row that truly doesn't exist) — see CLAUDE.md.
    expect(cross.status).toBe(403);
  });

  it("requires auth (401) for a protected route", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(401);
  });

  it("blocks a Pro-only render setting for a Free user (403 upgrade_required)", async () => {
    const { agent } = await signup("free@test.local");
    const create = await agent
      .post("/api/projects")
      .send({ name: "Gated", module: "studio" });
    const projectId = create.body.id as number;

    const patch = await agent
      .patch(`/api/projects/${projectId}/render-settings`)
      .send({ fps: 60 }); // 60fps is Pro-only
    expect(patch.status).toBe(403);
    expect(patch.body.reason).toBe("upgrade_required");
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("E2E — Track F avatar endpoints", () => {
  it("usage is sandbox/uncapped by default; session-token 503s without a key", async () => {
    const prevKey = process.env.LIVEAVATAR_API_KEY;
    const prevSandbox = process.env.LIVEAVATAR_SANDBOX;
    delete process.env.LIVEAVATAR_API_KEY; // unconfigured
    delete process.env.LIVEAVATAR_SANDBOX; // default → sandbox
    try {
      const { agent } = await signup("avatar@test.local");

      const usage = await agent.get("/api/avatar/usage");
      expect(usage.status).toBe(200);
      expect(usage.body.sandbox).toBe(true);
      expect(usage.body.used).toBe(0);

      const token = await agent.post("/api/avatar/session-token").send({});
      expect(token.status).toBe(503); // not configured
    } finally {
      if (prevKey === undefined) delete process.env.LIVEAVATAR_API_KEY;
      else process.env.LIVEAVATAR_API_KEY = prevKey;
      if (prevSandbox === undefined) delete process.env.LIVEAVATAR_SANDBOX;
      else process.env.LIVEAVATAR_SANDBOX = prevSandbox;
    }
  });
});
