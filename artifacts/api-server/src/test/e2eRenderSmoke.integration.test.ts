/**
 * FULL-STACK render smoke (CLAUDE.md Future work #3) — the one journey the HTTP
 * E2E suite (e2e.integration.test.ts) and the engine-only smokes
 * (smoke-render.mjs, transitionsRenderSmoke.test.ts) don't cover together:
 * signup → create project → POST /render → the REAL inline pipeline (Chrome
 * BeginFrame + FFmpeg via @hyperframes/producer) → poll to ready → the video
 * route serves a valid MP4 (including a Range request, exercising lib/httpRange
 * end-to-end).
 *
 * Drives the actual Express app over supertest against the testcontainer
 * Postgres, with REDIS_URL unset so the render runs INLINE in-process.
 *
 * GATED behind RENDER_SMOKE=1 (NOT part of the normal suite/CI — a real render
 * takes 1–3 minutes and needs the render toolchain: ffmpeg/ffprobe on PATH +
 * chrome-headless-shell). Run it with:
 *
 *   RENDER_SMOKE=1 pnpm exec vitest run \
 *     artifacts/api-server/src/test/e2eRenderSmoke.integration.test.ts
 *
 * The chrome-headless-shell path is auto-resolved from the puppeteer cache when
 * PRODUCER_HEADLESS_SHELL_PATH is unset, and <cwd>/core/dist is materialized from
 * node_modules (the producer reads its core runtime from there) — so a plain
 * RENDER_SMOKE=1 run is self-contained on a machine that has installed deps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";
import { renderDirFor } from "../services/renderService";
import { truncateAll } from "./integration";
import { INTEGRATION_AVAILABLE } from "./setup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Real render + a live testcontainer are both required, so this only runs when
// explicitly opted in AND Docker is up.
const RUN = process.env.RENDER_SMOKE === "1" && INTEGRATION_AVAILABLE;

/**
 * Resolve a chrome-headless-shell executable from the puppeteer download cache
 * (the only headless build that still implements BeginFrame — see CLAUDE.md). A
 * pre-set PRODUCER_HEADLESS_SHELL_PATH always wins.
 */
function resolveShellPath(): string | undefined {
  if (process.env.PRODUCER_HEADLESS_SHELL_PATH) {
    return process.env.PRODUCER_HEADLESS_SHELL_PATH;
  }
  const root = path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell");
  if (!fs.existsSync(root)) return undefined;
  for (const version of fs.readdirSync(root)) {
    const versionDir = path.join(root, version);
    if (!fs.statSync(versionDir).isDirectory()) continue;
    for (const platform of fs.readdirSync(versionDir)) {
      for (const exe of ["chrome-headless-shell.exe", "chrome-headless-shell"]) {
        const candidate = path.join(versionDir, platform, exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Materialize `<cwd>/core/dist` (the producer reads its core runtime from there
 * at render time; it's a gitignored build artifact). Mirrors smoke-render.mjs.
 */
function ensureCoreDist(): void {
  const dest = path.join(process.cwd(), "core", "dist");
  if (fs.existsSync(dest)) return;
  const candidates = [
    path.resolve(__dirname, "../../node_modules/@hyperframes/core/dist"),
    path.resolve(__dirname, "../../../../node_modules/@hyperframes/core/dist"),
  ];
  const src = candidates.find((c) => fs.existsSync(c));
  if (!src) return; // the engine will throw a clear "core runtime" error if truly missing
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

const PASSWORD = "supersecret123";
let ipCounter = 0;
/** Distinct per-call IP so the per-IP signup limiter doesn't throttle. */
const nextIp = (): string => `10.30.0.${(ipCounter += 1)}`;

async function signup(email: string): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/signup")
    .set("X-Forwarded-For", nextIp())
    .send({ email, password: PASSWORD });
  return agent;
}

beforeAll(() => {
  if (!RUN) return;
  ensureCoreDist();
  const shell = resolveShellPath();
  if (shell) process.env.PRODUCER_HEADLESS_SHELL_PATH = shell;
});

beforeEach(async () => {
  if (!RUN) return;
  await truncateAll();
});

describe.runIf(RUN)(
  "E2E full-stack render smoke (signup → create → render → MP4 served)",
  () => {
    it(
      "renders a real MP4 through the inline pipeline and serves it over the video route (incl. Range)",
      async () => {
        const agent = await signup("render-e2e@test.local");

        // Create a draft on the Studio composition (studio → studio-default.html,
        // the single-scene 1080x1920 template the engine smoke renders).
        const create = await agent
          .post("/api/projects")
          .send({ name: "E2E Render", module: "studio" });
        expect(create.status).toBe(201);
        const id = create.body.id as number;

        // Trigger the render — 202, then executeRender runs INLINE (REDIS_URL unset).
        const render = await agent.post(`/api/projects/${id}/render`);
        expect(render.status).toBe(202);

        // Poll to completion (a warm studio-default render is ~2 min).
        let status = "rendering";
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));
          const probe = await agent.get(`/api/projects/${id}`);
          status = probe.body.status as string;
          if (status === "ready" || status === "failed") break;
        }
        expect(status).toBe("ready");

        // The server-side artifact is a real, non-trivial, ffprobe-valid MP4.
        const outputPath = path.join(renderDirFor(id), "output.mp4");
        expect(fs.existsSync(outputPath)).toBe(true);
        expect(fs.statSync(outputPath).size).toBeGreaterThan(10_000);
        const duration = execFileSync(
          "ffprobe",
          ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outputPath],
          { encoding: "utf-8" },
        ).trim();
        expect(parseFloat(duration)).toBeGreaterThan(0);

        // The video route serves it (full GET).
        const full = await agent.get(`/api/projects/${id}/video`);
        expect(full.status).toBe(200);
        expect(full.headers["content-type"]).toContain("video/mp4");
        expect(full.headers["accept-ranges"]).toBe("bytes");
        expect(Number(full.headers["content-length"])).toBeGreaterThan(10_000);

        // …and honours a Range request — exercises lib/httpRange end-to-end.
        const ranged = await agent
          .get(`/api/projects/${id}/video`)
          .set("Range", "bytes=0-99");
        expect(ranged.status).toBe(206);
        expect(ranged.headers["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
        expect(Number(ranged.headers["content-length"])).toBe(100);
      },
      300_000,
    );
  },
);
