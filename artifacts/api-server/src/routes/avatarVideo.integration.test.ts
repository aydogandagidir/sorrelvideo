import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { db, projectsTable, usersTable, renderJobsTable } from "@workspace/db";
import { createSession } from "../lib/auth";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";
import { renderDirFor, VOICEOVER_FILENAME } from "../services/renderService";

/**
 * E2E for POST /api/avatar/video (script → talking-host project + auto-render)
 * against the real Express app + testcontainer Postgres. The OpenAI calls
 * (TTS + Whisper) are stubbed at the fetch layer; `enqueueRender` is a no-op
 * mock so the inline pipeline never launches a real Chrome render — the
 * assertions stop at the claimed project + ledger row, exactly like the other
 * render-route suites.
 */

vi.mock("../lib/renderQueue", async (importActual) => {
  const actual = await importActual<typeof import("../lib/renderQueue")>();
  return { ...actual, enqueueRender: vi.fn(async () => undefined) };
});

const app = (await import("../app")).default;

const ENV_KEYS = ["TTS_API_KEY", "OPENAI_API_KEY", "WHISPER_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

const SCRIPT = "Hello world, this is my talking host script.";

/** `*ResetAt` is the NEXT reset boundary (isNewMonth: now >= resetAt → zeroed),
 * so an exhausted-quota fixture must point it at the FUTURE. */
function nextMonthBoundary(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function stubOpenAi() {
  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/v1/audio/speech")) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([73, 68, 51, 4]).buffer,
      } as unknown as Response;
    }
    if (u.includes("/v1/audio/transcriptions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          duration: 6.6,
          words: [
            { word: "Hello", start: 0, end: 0.4 },
            { word: "world", start: 0.5, end: 1.1 },
          ],
        }),
      } as unknown as Response;
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  delete process.env.REDIS_URL;
  await truncateAll();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe.runIf(INTEGRATION_AVAILABLE)("E2E — POST /api/avatar/video", () => {
  it("requires auth (401)", async () => {
    const res = await request(app)
      .post("/api/avatar/video")
      .send({ script: SCRIPT });
    expect(res.status).toBe(401);
  });

  it("503s when TTS is not configured (deterministic, no provider call)", async () => {
    const userId = await createFreeUser();
    const sid = await createSession({ userId });
    const res = await request(app)
      .post("/api/avatar/video")
      .set("Authorization", `Bearer ${sid}`)
      .send({ script: SCRIPT });
    expect(res.status).toBe(503);
  });

  it("creates a talking-host project, charges one AI unit, and auto-starts the render", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubOpenAi();
    const userId = await createFreeUser();
    const sid = await createSession({ userId });

    const res = await request(app)
      .post("/api/avatar/video")
      .set("Authorization", `Bearer ${sid}`)
      .send({ script: SCRIPT, voice: "nova" });

    expect(res.status).toBe(201);
    expect(res.body.renderStarted).toBe(true);
    expect(res.body.renderMessage).toBeNull();

    const project = res.body.project as {
      id: number;
      module: string;
      status: string;
      compositionVars: Record<string, string>;
      renderSettings: {
        resolution: string;
        voiceover: { objectPath: string | null; startAt: number; volume: number };
      };
    };
    expect(project.module).toBe("talking-host");
    // Auto-render claimed the project (enqueueRender is a no-op mock).
    expect(project.status).toBe("rendering");
    expect(project.renderSettings.resolution).toBe("portrait");
    // GCS is unconfigured here → the local render-dir copy is the only source.
    expect(project.renderSettings.voiceover).toEqual({
      objectPath: null,
      startAt: 0.9,
      volume: 100,
    });

    // The payload decodes back to the Whisper words; duration = 0.9 + 6.6 + 1.4.
    const payload = JSON.parse(
      Buffer.from(project.compositionVars["host.payload"], "base64").toString(
        "utf-8",
      ),
    ) as { intro: number; outro: number; words: [string, number, number][] };
    expect(payload.words).toEqual([
      ["Hello", 0, 0.4],
      ["world", 0.5, 1.1],
    ]);
    expect(project.compositionVars.duration).toBe("8.9");

    // The narration was staged as the render-dir sibling the pipeline reads.
    expect(
      fs.existsSync(path.join(renderDirFor(project.id), VOICEOVER_FILENAME)),
    ).toBe(true);

    // Exactly one AI unit charged, one ledger row opened.
    const [user] = await db
      .select({ aiCount: usersTable.aiCount })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(user.aiCount).toBe(1);
    const jobs = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.projectId, project.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].backend).toBe("inline");
  });

  it("403s (upgrade_required) at the AI quota and creates NO project", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubOpenAi();
    const userId = await createFreeUser();
    await db
      .update(usersTable)
      .set({ aiCount: 10, aiResetAt: nextMonthBoundary() }) // FREE_AI_LIMIT
      .where(eq(usersTable.id, userId));
    const sid = await createSession({ userId });

    const res = await request(app)
      .post("/api/avatar/video")
      .set("Authorization", `Bearer ${sid}`)
      .send({ script: SCRIPT });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("upgrade_required");
    const projects = await db.select().from(projectsTable);
    expect(projects).toHaveLength(0);
  });

  it("degrades to a draft when the RENDER quota is exhausted (AI unit still spent)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubOpenAi();
    const userId = await createFreeUser();
    await db
      .update(usersTable)
      .set({ renderCount: 3, renderResetAt: nextMonthBoundary() }) // FREE_RENDER_LIMIT
      .where(eq(usersTable.id, userId));
    const sid = await createSession({ userId });

    const res = await request(app)
      .post("/api/avatar/video")
      .set("Authorization", `Bearer ${sid}`)
      .send({ script: SCRIPT });

    expect(res.status).toBe(201);
    expect(res.body.renderStarted).toBe(false);
    expect(String(res.body.renderMessage)).toContain("render limit");
    expect(res.body.project.status).toBe("draft");

    const [user] = await db
      .select({
        aiCount: usersTable.aiCount,
        renderCount: usersTable.renderCount,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    // The narration was real → the AI unit stays spent; the blocked render
    // attempt must NOT consume (or refund into) the render quota.
    expect(user.aiCount).toBe(1);
    expect(user.renderCount).toBe(3);
  });
});
