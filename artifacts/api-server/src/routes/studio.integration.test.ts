import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { db, projectsTable } from "@workspace/db";
import app from "../app";
import { createSession } from "../lib/auth";
import { writeFile as writeWorkspaceFile } from "../services/studioWorkspaceService";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * Regression guard for the website-showcase data-loss bug (step #2 fix).
 *
 * Opening a project in the embedded Studio seeds its workspace `index.html` the
 * first time. A project whose content lives in `compositionVars` (with
 * `compositionHtml` null) — e.g. a website-showcase project — MUST be seeded with
 * its REAL, vars-substituted composition (via buildCompositionHtml), NOT the
 * blank `studio-default` timelines editor. Seeding the blank doc and then saving
 * it would overwrite `compositionHtml`, permanently losing the showcase at
 * render time. This test proves the opened workspace contains the showcase
 * markup and none of the studio-default markers.
 *
 * The studio workspace dir is pointed at a throwaway temp dir so the seeded file
 * is isolated per-test and cleaned up afterward.
 */

let workspaceDir: string;
let prevWorkspaceEnv: string | undefined;

beforeEach(async () => {
  await truncateAll();
  prevWorkspaceEnv = process.env.STUDIO_WORKSPACE_DIR;
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ws-test-"));
  process.env.STUDIO_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (prevWorkspaceEnv === undefined) delete process.env.STUDIO_WORKSPACE_DIR;
  else process.env.STUDIO_WORKSPACE_DIR = prevWorkspaceEnv;
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "GET /api/studio/projects/:id — website-showcase seed",
  () => {
    it("seeds the REAL showcase composition, not the blank studio-default", async () => {
      const userId = await createFreeUser();
      const sid = await createSession({ userId });

      // A website-showcase project exactly as websiteToVideoService creates one:
      // content carried in compositionVars, compositionHtml still null.
      const [project] = await db
        .insert(projectsTable)
        .values({
          userId,
          name: "example.com",
          module: "website-showcase",
          compositionVars: {
            "capture.image": "data:image/png;base64,AAAA",
            "capture.height": "1080",
            "capture.url": "https://example.com",
            "capture.title": "Example Domain",
          },
          renderSettings: null,
        })
        .returning();

      // Open the project in the studio — this seeds the workspace.
      const openRes = await request(app)
        .get(`/api/studio/projects/${project.id}`)
        .set("Authorization", `Bearer ${sid}`);
      expect(openRes.status).toBe(200);
      expect(openRes.body.files).toContain("index.html");

      // Read the seeded entry file back and assert it is the showcase
      // composition (its unique markers), NOT the studio-default timelines seed.
      const fileRes = await request(app)
        .get(`/api/studio/projects/${project.id}/files/index.html`)
        .set("Authorization", `Bearer ${sid}`);
      expect(fileRes.status).toBe(200);

      const html: string = fileRes.body.content;
      // Showcase markers (proves buildCompositionHtml rendered the real comp).
      expect(html).toContain('data-composition-id="website-showcase"');
      expect(html).toContain('class="browser"');
      // The vars were substituted into the composition, not left as {{tokens}}.
      expect(html).toContain("https://example.com");
      expect(html).not.toContain("{{capture.url}}");
      // And it is NOT the blank studio-default timelines editor.
      expect(html).not.toContain('data-composition-id="studio"');
    });
  },
);

describe.runIf(INTEGRATION_AVAILABLE)(
  "studio preview + lint (the editor's iframe/lint contract)",
  () => {
    async function makeStudioProject() {
      const userId = await createFreeUser();
    const sid = await createSession({ userId });
      const [project] = await db
        .insert(projectsTable)
        .values({ userId, name: "Studio P", module: "studio" })
        .returning();
      return { sid, project };
    }

    it("GET /preview serves the entry composition as HTML (seeding if needed)", async () => {
      const { sid, project } = await makeStudioProject();
      const res = await request(app)
        .get(`/api/studio/projects/${project.id}/preview`)
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain("<html");
      expect(res.text).toContain("__timelines"); // the studio timeline seed
    });

    it("GET /preview/<file> serves workspace files (asset wildcard)", async () => {
      const { sid, project } = await makeStudioProject();
      // Seed via the master preview first, then fetch the entry as an asset.
      await request(app)
        .get(`/api/studio/projects/${project.id}/preview`)
        .set("Authorization", `Bearer ${sid}`);
      const res = await request(app)
        .get(`/api/studio/projects/${project.id}/preview/index.html`)
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      const missing = await request(app)
        .get(`/api/studio/projects/${project.id}/preview/nope.css`)
        .set("Authorization", `Bearer ${sid}`);
      expect(missing.status).toBe(404);
    });

    it("self-heals a stale default seed on open (pre-contract doc, never saved)", async () => {
      const { sid, project } = await makeStudioProject();
      // First open seeds the CURRENT doc; then simulate a workspace that
      // survived from an older deploy by writing the legacy ms-era seed
      // directly through the service (bypassing the entry-save persistence).
      await request(app)
        .get(`/api/studio/projects/${project.id}`)
        .set("Authorization", `Bearer ${sid}`);
      const legacy =
        '<html><body><div data-composition-id="studio-default"></div>' +
        "<script>var DURATION_MS = 5000;</script></body></html>";
      await writeWorkspaceFile(
        project.userId,
        String(project.id),
        "index.html",
        legacy,
      );

      // Re-open → the stale seed is detected and refreshed in place.
      const reopen = await request(app)
        .get(`/api/studio/projects/${project.id}`)
        .set("Authorization", `Bearer ${sid}`);
      expect(reopen.status).toBe(200);

      const entry = await request(app)
        .get(`/api/studio/projects/${project.id}/files/index.html`)
        .set("Authorization", `Bearer ${sid}`);
      expect(entry.body.content).toContain("isActive"); // new contract
      expect(entry.body.content).not.toContain("DURATION_MS");
    });

    it("GET /lint runs the engine linter and returns findings JSON", async () => {
      const { sid, project } = await makeStudioProject();
      const res = await request(app)
        .get(`/api/studio/projects/${project.id}/lint`)
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(Array.isArray(res.body.findings)).toBe(true);
      expect(typeof res.body.errorCount).toBe("number");
      // The seed composition must not be reported broken by our own linter —
      // this doubles as a quality gate on studio-default-timelines.html.
      expect(res.body.errorCount).toBe(0);
    });
  },
);

/**
 * Studio 0.6.91 surface: fonts, block catalog, render-file download, and the
 * deliberate 501 stubs. The stubs must gate auth+ownership BEFORE the 501 so
 * they leak no project existence; the catalog must serve the vendored manifest
 * (never the live upstream registry).
 */
describe.runIf(INTEGRATION_AVAILABLE)(
  "studio 0.6.91 surface (fonts / catalog / stubs)",
  () => {
    async function makeOwnedProject(): Promise<{ sid: string; id: number }> {
      const userId = await createFreeUser();
      const sid = await createSession({ userId });
      const [project] = await db
        .insert(projectsTable)
        .values({ userId, name: "Stub target", module: "studio" })
        .returning();
      return { sid, id: project.id };
    }

    it("GET /fonts returns the installed font families", async () => {
      const { sid } = await makeOwnedProject();
      const res = await request(app)
        .get("/api/studio/fonts")
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.fonts)).toBe(true);
      for (const f of res.body.fonts) expect(typeof f).toBe("string");
    });

    it("GET /fonts/google returns a non-empty family list (fallback-backed)", async () => {
      const { sid } = await makeOwnedProject();
      const res = await request(app)
        .get("/api/studio/fonts/google")
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(200);
      // Offline/unreachable metadata degrades to the static fallback list, so
      // a non-empty array is guaranteed either way.
      expect(res.body.fonts.length).toBeGreaterThan(0);
    });

    it("GET /registry/blocks serves the vendored manifest as RegistryItem[]", async () => {
      const { sid } = await makeOwnedProject();
      const res = await request(app)
        .get("/api/studio/registry/blocks")
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      const chart = res.body.find(
        (b: { name: string }) => b.name === "data-chart",
      );
      expect(chart).toBeDefined();
      expect(chart.type).toBe("hyperframes:block");
      expect(chart.title.length).toBeGreaterThan(0);
      expect(Array.isArray(chart.files)).toBe(true);
      expect(chart.preview.poster).toContain("/api/templates/thumbnails/");
      expect(chart.dimensions.width).toBeGreaterThan(0);
    });

    it("file-mutations stub: 501 for the owner, 403 for a non-owner", async () => {
      const { sid, id } = await makeOwnedProject();
      const owner = await request(app)
        .post(`/api/studio/projects/${id}/file-mutations/patch-element/index.html`)
        .set("Authorization", `Bearer ${sid}`);
      expect(owner.status).toBe(501);
      expect(owner.body.error).toContain("Not supported");

      const otherId = await createFreeUser();
      const otherSid = await createSession({ userId: otherId });
      const stranger = await request(app)
        .post(`/api/studio/projects/${id}/file-mutations/patch-element/index.html`)
        .set("Authorization", `Bearer ${otherSid}`);
      expect(stranger.status).toBe(403);
    });

    it("gsap-mutations / waveform / registry-install stubs return 501 for the owner", async () => {
      const { sid, id } = await makeOwnedProject();
      const gsap = await request(app)
        .post(`/api/studio/projects/${id}/gsap-mutations/index.html`)
        .set("Authorization", `Bearer ${sid}`);
      expect(gsap.status).toBe(501);

      const waveform = await request(app)
        .get(`/api/studio/projects/${id}/waveform/assets/audio.mp3`)
        .set("Authorization", `Bearer ${sid}`);
      expect(waveform.status).toBe(501);

      const install = await request(app)
        .post(`/api/studio/projects/${id}/registry/install`)
        .set("Authorization", `Bearer ${sid}`);
      expect(install.status).toBe(501);
    });

    it("renders/file 404s for a filename no ready job advertises", async () => {
      const { sid, id } = await makeOwnedProject();
      const res = await request(app)
        .get(`/api/studio/projects/${id}/renders/file/output.mp4`)
        .set("Authorization", `Bearer ${sid}`);
      expect(res.status).toBe(404);
    });
  },
);
