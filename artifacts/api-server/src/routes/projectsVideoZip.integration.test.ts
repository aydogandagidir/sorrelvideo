import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { db, projectsTable, renderJobsTable } from "@workspace/db";
import app from "../app";
import { createSession } from "../lib/auth";
import { renderDirFor } from "../services/renderService";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * GET /api/projects/:id/video for a PNG-SEQUENCE render streams the frames
 * directory back as a zip (replacing the old 409 "not available yet"). The
 * artifact path getRenderArtifact resolves is the project's render dir +
 * "frames"; this test materializes that dir with two tiny valid PNGs, marks a
 * ready render-job pointing at it, and asserts the route returns a real zip.
 */

// A 1×1 transparent PNG (69 bytes) — a real, decodable image so the zip holds
// genuine frame bytes, not a placeholder.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const createdFrameDirs: string[] = [];

beforeEach(async () => {
  delete process.env.REDIS_URL;
  await truncateAll();
});

afterEach(() => {
  for (const dir of createdFrameDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Stage a ready png-sequence project: a `ready` project + a `ready` render-job
 * whose `config.format` is png-sequence and whose `outputPath` is the frames
 * directory (filled with two PNGs). Returns the owner session + project id.
 */
async function stagePngSequenceProject(): Promise<{
  sid: string;
  id: number;
  framesDir: string;
}> {
  const userId = await createFreeUser();
  const sid = await createSession({ userId });
  const [project] = await db
    .insert(projectsTable)
    .values({ userId, name: "Frames", module: "studio", status: "ready" })
    .returning();

  const framesDir = path.join(renderDirFor(project.id), "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(path.join(framesDir, "frame_000001.png"), TINY_PNG);
  fs.writeFileSync(path.join(framesDir, "frame_000002.png"), TINY_PNG);
  createdFrameDirs.push(renderDirFor(project.id));

  await db.insert(renderJobsTable).values({
    projectId: project.id,
    userId,
    backend: "inline",
    status: "ready",
    progress: 100,
    config: {
      fps: 30,
      quality: "draft",
      format: "png-sequence",
      resolution: "portrait",
      transparent: true,
      watermark: true,
    },
    format: "png-sequence",
    outputPath: framesDir,
  });

  return { sid, id: project.id, framesDir };
}

describe.runIf(INTEGRATION_AVAILABLE)(
  "GET /api/projects/:id/video — png-sequence zip download",
  () => {
    it("streams the frames directory back as a zip attachment", async () => {
      const { sid, id } = await stagePngSequenceProject();

      const res = await request(app)
        .get(`/api/projects/${id}/video`)
        .set("Authorization", `Bearer ${sid}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/zip");
      expect(res.headers["content-disposition"]).toContain(
        `attachment; filename="project-${id}-frames.zip"`,
      );
      const body = res.body as Buffer;
      // ZIP local-file-header magic "PK\x03\x04".
      expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(body.length).toBeGreaterThan(0);
      // Both frame names appear in the central directory (stored, not deflated).
      const text = body.toString("latin1");
      expect(text).toContain("frame_000001.png");
      expect(text).toContain("frame_000002.png");
    });

    it("403s a non-owner (the zip path is still ownership-gated)", async () => {
      const { id } = await stagePngSequenceProject();
      const strangerId = await createFreeUser();
      const strangerSid = await createSession({ userId: strangerId });

      const res = await request(app)
        .get(`/api/projects/${id}/video`)
        .set("Authorization", `Bearer ${strangerSid}`);
      expect(res.status).toBe(403);
    });

    it("401s without a session", async () => {
      const { id } = await stagePngSequenceProject();
      const res = await request(app).get(`/api/projects/${id}/video`);
      expect(res.status).toBe(401);
    });
  },
);
