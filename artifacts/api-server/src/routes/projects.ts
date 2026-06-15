import fs from "fs";
import archiver from "archiver";
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  templatesTable,
  usersTable,
  type RenderSettings,
} from "@workspace/db";
import {
  ListProjectsResponse,
  CreateProjectBody,
  GetProjectParams,
  GetProjectResponse,
  UpdateProjectParams,
  UpdateProjectBody,
  UpdateProjectResponse,
  DeleteProjectParams,
  UpdateProjectRenderSettingsParams,
  UpdateProjectRenderSettingsBody,
} from "@workspace/api-zod";
import {
  renderFileExistsAsync,
  getRenderArtifact,
  buildCompositionHtml,
  RENDERS_DIR,
} from "../services/renderService";
import { getThumbnailPath } from "../services/thumbnailService";
import {
  resolveSettings,
  assertRenderSettingsAllowed,
} from "../services/renderSettingsService";
import { removeQueuedRender } from "../lib/renderQueue";
import {
  requestCancel,
  getLatestJobForProject,
} from "../services/renderJobsService";
import { startProjectRender } from "../services/renderStartService";
import { getUserPlan } from "../services/billingService";
import { findUnsafeCompositionVar } from "../lib/compositionVars";
import { findInvalidTypedVar } from "../lib/typedVars";
import { variablesForModule } from "../services/registryTemplates";
import { logger } from "../lib/logger";
import { serveTemplateAsset } from "../lib/templateAssets";
import { resolveByteRange } from "../lib/httpRange";

/**
 * Validate a project's compositionVars against the typed variables its module
 * declares. Returns the first violation's `{ reason }` or null. No-op when the
 * vars are absent or the module declares no typed variables.
 */
function findInvalidTypedVars(
  module: string,
  vars: Record<string, string> | null | undefined,
): { reason: string } | null {
  if (!vars) return null;
  const typed = variablesForModule(module);
  if (!typed) return null;
  const invalid = findInvalidTypedVar(vars, typed);
  return invalid ? { reason: invalid.reason } : null;
}

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

/** A project row with the live-progress fields the UI reads (M10). */
type ProjectRow = typeof projectsTable.$inferSelect;
type ProjectWithProgress = ProjectRow & {
  renderProgress: number | null;
  renderCost: number | null;
};

/**
 * Attach the latest render job's live `renderProgress`/`renderCost` to a project,
 * but ONLY while it is actually rendering — that's the only window the UI needs
 * live values, and it keeps the list query cheap (no heavy join). Non-rendering
 * projects get nulls without any DB lookup. Callers pre-filter the rendering
 * subset so we never N+1 over the whole list.
 */
async function withRenderProgress(
  project: ProjectRow,
): Promise<ProjectWithProgress> {
  if (project.status !== "rendering") {
    return { ...project, renderProgress: null, renderCost: null };
  }
  const job = await getLatestJobForProject(project.id);
  return {
    ...project,
    renderProgress: job?.progress ?? null,
    renderCost: job?.costCents ?? null,
  };
}

router.get("/projects", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, req.user.id))
    .orderBy(projectsTable.updatedAt);

  // Attach live progress/cost. withRenderProgress only hits render_jobs for
  // rendering projects (the rest resolve to nulls synchronously), so this is a
  // lookup per *rendering* project — typically a handful — not an N+1 over the
  // whole list. Ordering is preserved (Promise.all keeps index order).
  const withProgress = await Promise.all(projects.map(withRenderProgress));

  res.json(ListProjectsResponse.parse(serializeDates(withProgress)));
});

router.post("/projects", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // compositionVars is overlaid over the brand kit at render time and reaches
  // dangerous composition contexts (an `<img src>` attribute, unquoted CSS/SVG
  // paint) where the template's quote-preserving escaping can't protect it.
  // Reject injection-unsafe values up front, mirroring the brand-kit logoUrl gate.
  const unsafeVar = findUnsafeCompositionVar(parsed.data.compositionVars);
  if (unsafeVar) {
    res.status(400).json({ error: unsafeVar.reason });
    return;
  }

  // Typed-variable validation: if the template module declares typed variables,
  // every supplied compositionVar matching one must satisfy its type (number
  // bounds, enum membership, safe color, …). Closes the gap where a typed color
  // — not in compositionVars' fixed COLOR_KEYS — would reach the render unchecked.
  const typedInvalid = findInvalidTypedVars(
    parsed.data.module,
    parsed.data.compositionVars,
  );
  if (typedInvalid) {
    res.status(400).json({ error: typedInvalid.reason });
    return;
  }

  const [project] = await db
    .insert(projectsTable)
    .values({ ...parsed.data, userId: req.user.id })
    .returning();
  res.status(201).json(GetProjectResponse.parse(serializeDates(project)));
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, params.data.id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Attach live progress/cost (only looked up while rendering, see helper).
  const withProgress = await withRenderProgress(project);
  res.json(GetProjectResponse.parse(serializeDates(withProgress)));
});

router.patch("/projects/:id", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateProjectParams.safeParse({ id: parseInt(rawId, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Same compositionVars injection gate as POST /projects — a PATCH must not be
  // able to smuggle an attribute-breakout logoUrl/image or a CSS url() color past
  // the render template's quote-preserving escaping.
  const unsafeVar = findUnsafeCompositionVar(parsed.data.compositionVars);
  if (unsafeVar) {
    res.status(400).json({ error: unsafeVar.reason });
    return;
  }

  const [existing] = await db
    .select({ userId: projectsTable.userId, module: projectsTable.module })
    .from(projectsTable)
    .where(eq(projectsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (existing.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Typed-variable validation against the project's module (resolved after the
  // ownership gate, since the module lives on the existing row).
  const typedInvalid = findInvalidTypedVars(
    existing.module,
    parsed.data.compositionVars,
  );
  if (typedInvalid) {
    res.status(400).json({ error: typedInvalid.reason });
    return;
  }

  const [project] = await db
    .update(projectsTable)
    .set(parsed.data)
    .where(eq(projectsTable.id, params.data.id))
    .returning();

  res.json(UpdateProjectResponse.parse(serializeDates(project)));
});

router.delete("/projects/:id", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteProjectParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select({ userId: projectsTable.userId })
    .from(projectsTable)
    .where(eq(projectsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (existing.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Deleting the project also prunes its render_jobs ledger rows: the
  // render_jobs.project_id → projects.id FK is ON DELETE CASCADE (see
  // lib/db/src/schema/render.ts), so the DB removes them in the same statement.
  // This keeps the ledger from accumulating orphans (it is scanned on every
  // distributed-quota check and boot recovery). NOTE: the cascade only exists
  // once the new FK is applied via `pnpm --filter @workspace/db run push`
  // (manual on prod); until then deletes leave render_jobs rows behind.
  await db.delete(projectsTable).where(eq(projectsTable.id, params.data.id));

  res.sendStatus(204);
});

// PATCH /api/projects/:id/render-settings — update render config (Pro-gated).
// Dedicated endpoint (NOT the generic PATCH) so Pro-only capabilities can't be
// set un-gated. The same gate runs again at render time (defense in depth).
router.patch(
  "/projects/:id/render-settings",
  async (req, res): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const rawId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;
    const params = UpdateProjectRenderSettingsParams.safeParse({
      id: parseInt(rawId, 10),
    });
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateProjectRenderSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [existing] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, params.data.id));

    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (existing.userId !== req.user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Merge the partial over the project's current settings (or defaults), then
    // gate against the plan before persisting the fully-resolved object.
    const patch: Partial<RenderSettings> = parsed.data;
    const merged = resolveSettings({
      ...(existing.renderSettings ?? {}),
      ...patch,
    });

    const [userRow] = await db
      .select({ stripeCustomerId: usersTable.stripeCustomerId })
      .from(usersTable)
      .where(eq(usersTable.id, req.user.id));
    const plan = await getUserPlan(userRow?.stripeCustomerId ?? null);

    try {
      assertRenderSettingsAllowed(merged, plan);
    } catch (err) {
      const e = err as { reason?: string; message?: string };
      if (e.reason === "upgrade_required") {
        res.status(403).json({
          error: e.message ?? "Upgrade required",
          reason: "upgrade_required",
        });
        return;
      }
      throw err;
    }

    const [project] = await db
      .update(projectsTable)
      .set({ renderSettings: merged })
      .where(eq(projectsTable.id, params.data.id))
      .returning();

    res.json(GetProjectResponse.parse(serializeDates(project)));
  },
);

// POST /api/projects/:id/render — kick off async render
router.post("/projects/:id/render", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Check premium template access (pro users only) — read-only, so a 403 here
  // costs nothing and stays before the render claim.
  if (project.templateId) {
    const [template] = await db
      .select()
      .from(templatesTable)
      .where(eq(templatesTable.id, project.templateId));
    if (template?.isPremium) {
      const [userRow] = await db
        .select({ stripeCustomerId: usersTable.stripeCustomerId })
        .from(usersTable)
        .where(eq(usersTable.id, req.user.id));
      const userPlan = await getUserPlan(userRow?.stripeCustomerId ?? null);
      if (userPlan !== "pro") {
        res.status(403).json({
          error: "Premium templates require Pro plan",
          reason: "upgrade_required",
        });
        return;
      }
    }
  }

  // Claim → quota → settings re-gate → ledger → enqueue, with every
  // claim-release/refund pairing — extracted to startProjectRender (shared with
  // the talking-host auto-render). This route only maps the result codes back
  // to its original response bodies.
  const start = await startProjectRender(req.user.id, project);
  if (!start.ok) {
    switch (start.code) {
      case "already_rendering":
        res.status(409).json({ error: "Render already in progress" });
        return;
      case "upgrade_required":
        res.status(403).json({
          error: start.message,
          reason: "upgrade_required",
        });
        return;
      case "unavailable":
        res
          .status(503)
          .json({ error: "Could not start render. Please try again." });
        return;
    }
  }

  res.status(202).json(GetProjectResponse.parse(serializeDates(start.project)));
});

// POST /api/projects/:id/render/cancel — request cancellation of an in-flight
// render. Flags the latest render-job row (owner-scoped) and best-effort drops
// any still-queued job so it never starts. The running worker observes the flag
// in its progress callback (M2), throws RenderCancelledError, and finalizes the
// project back to `draft` + marks the job cancelled — so we don't touch the
// project status here, just acknowledge with the current row.
router.post("/projects/:id/render/cancel", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Nothing to cancel unless the latest job is still queued or actively
  // rendering. ready/failed/cancelled (or no job at all) → 409.
  const job = await getLatestJobForProject(id);
  if (!job || (job.status !== "queued" && job.status !== "rendering")) {
    res.status(409).json({ error: "No render in progress" });
    return;
  }

  await requestCancel(job.id, req.user.id);
  await removeQueuedRender(id);

  res.json(GetProjectResponse.parse(serializeDates(project)));
});

// GET /api/projects/:id/video — stream the rendered mp4 file
router.get("/projects/:id/video", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db
    .select({ userId: projectsTable.userId, status: projectsTable.status })
    .from(projectsTable)
    .where(eq(projectsTable.id, id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  if (project.status !== "ready" || !(await renderFileExistsAsync(id))) {
    res.status(404).json({ error: "Video not available yet" });
    return;
  }

  // Resolve the real artifact path + container format from the latest ready
  // render job (falls back to legacy output.mp4 / mp4 for old projects).
  const { path: filePath, format } = await getRenderArtifact(id);

  // png-sequence renders an OUTPUT DIRECTORY of frames (+ an optional audio
  // sidecar), not a single streamable file. Stream it back as a zip built on
  // the fly. archiver reads one entry at a time and respects `res` backpressure
  // — constant memory regardless of frame count; PNGs are already compressed so
  // we STORE (level 0) for ~10x faster archiving. No Content-Length (size is
  // unknown until finalize) → chunked transfer, and Range requests are ignored
  // (answered as a full 200) — zip downloads don't resume, an accepted trade.
  if (format === "png-sequence") {
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="project-${id}-frames.zip"`,
    );

    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("warning", (err: Error) => {
      logger.warn({ err, projectId: id }, "zip archive warning");
    });
    archive.on("error", (err: Error) => {
      logger.error({ err, projectId: id }, "zip archive error");
      // Headers are already sent (streaming) — destroy the socket so the client
      // sees a truncated/aborted download rather than a silently-OK partial zip.
      res.destroy(err);
    });
    // Client aborted (closed the tab / cancelled the download) → stop reading
    // frames off disk immediately.
    req.on("close", () => archive.destroy());

    archive.pipe(res);
    // `filePath` IS the frames directory for png-sequence (getRenderArtifact).
    // `false` = no top-level folder; picks up the engine's optional audio.aac
    // sidecar written alongside the frames (intentional — it's part of the render).
    archive.directory(filePath, false);
    void archive.finalize();
    return;
  }

  // Per-format MIME + extension for the Content-Type / Content-Disposition.
  // png-sequence is handled above (409); every other format is a single file.
  type StreamFormat = Exclude<typeof format, "png-sequence">;
  const VIDEO_MIME: Record<StreamFormat, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    gif: "image/gif",
  };
  const EXT: Record<StreamFormat, string> = {
    mp4: "mp4",
    webm: "webm",
    mov: "mov",
    gif: "gif",
  };

  // Stream with HTTP range support (browser <video> seeking issues range
  // requests). We avoid res.sendFile here: Express 5's send() rejects absolute
  // paths containing spaces (this repo lives under ".../Artificial Inteligence/...")
  // with a spurious NotFoundError.
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  res.setHeader("Content-Type", VIDEO_MIME[format]);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="project-${id}.${EXT[format]}"`,
  );

  if (range) {
    // Single-range parsing extracted to lib/httpRange (unit-tested): handles
    // suffix ranges (last N bytes), open-ended ranges, past-EOF clamping, and
    // returns null for inverted / unsatisfiable ranges → a clean 416.
    const resolved = resolveByteRange(range, total);
    if (!resolved) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`);
      res.end();
      return;
    }
    const { start, end } = resolved;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader("Content-Length", total);
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/projects/:id/composition — serve the fully-substituted composition
// HTML so the frontend player can preview it WITHOUT a render. Auth + ownership
// mirror the video route. An optional `?vars=<base64 JSON object>` overrides the
// project's saved compositionVars (so the Studio editor can preview UNSAVED
// edits); when absent the saved compositionVars are used as-is.
router.get("/projects/:id/composition", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Resolve the vars to substitute. Optional `?vars=` is a base64-encoded JSON
  // OBJECT of overrides, merged OVER the saved compositionVars so previewing
  // unsaved Studio edits doesn't drop the persisted ones. Malformed (bad
  // base64, non-JSON, or a non-object) → 400.
  let mergedVars: Record<string, string> | null = project.compositionVars;
  const rawVars = req.query.vars;
  if (typeof rawVars === "string" && rawVars.length > 0) {
    let overrides: unknown;
    try {
      overrides = JSON.parse(Buffer.from(rawVars, "base64").toString("utf-8"));
    } catch {
      res.status(400).json({ error: "Invalid vars: not base64-encoded JSON" });
      return;
    }
    if (
      typeof overrides !== "object" ||
      overrides === null ||
      Array.isArray(overrides)
    ) {
      res.status(400).json({ error: "Invalid vars: expected a JSON object" });
      return;
    }
    // Injection gate on the `?vars=` overrides (the SAME gate POST/PATCH apply).
    // This route re-merges + substitutes into the composition, and the template
    // layer's escaping does NOT escape quotes — so a crafted override (e.g. a
    // brand.logoUrl breaking out of `src="…"`) would be reflected XSS against a
    // victim who opens a guessed project's preview link. Reject it up front.
    const unsafePreviewVar = findUnsafeCompositionVar(
      overrides as Record<string, string>,
    );
    if (unsafePreviewVar) {
      res.status(400).json({ error: unsafePreviewVar.reason });
      return;
    }
    mergedVars = {
      ...(project.compositionVars ?? {}),
      ...(overrides as Record<string, string>),
    };
  }

  // NOTE: compositionHtml is deliberately NOT passed — this route must re-merge
  // the template so the `?vars=` live-edit overrides take effect (passing a
  // saved doc would return it verbatim). brandKitId IS passed so the preview
  // uses the project's pinned kit (or the user's default), matching the render.
  const html = await buildCompositionHtml({
    id: project.id,
    userId: project.userId,
    module: project.module,
    compositionVars: mergedVars,
    brandKitId: project.brandKitId,
    // Lay the preview out at the project's chosen aspect, so what you see here
    // matches the rendered mp4 (and the Studio editor seed below).
    renderSettings: project.renderSettings,
  });

  // Preview must reflect live edits, never a cached copy.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // A string body is safe to res.send — the Express-5 spaces-in-path issue only
  // affects res.sendFile, which we deliberately avoid here.
  res.send(html);
});

// GET /api/projects/:id/assets/:name — serve a vendored sibling asset
// (avatar/background/sfx) for a project created from a multi-file template, so
// the `/composition` preview iframe resolves the composition's `assets/<name>`
// refs. Auth + ownership mirror `/composition`; the name is allow-listed against
// the manifest (serveTemplateAsset). Source is the COMMITTED compositions/assets
// dir (not the render dir), so it works for drafts that never rendered.
router.get("/projects/:id/assets/:name", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, id));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const name = Array.isArray(req.params.name)
    ? req.params.name[0]
    : req.params.name;
  serveTemplateAsset(res, project.module, name);
});

// GET /api/projects/:id/thumbnail — stream the rendered poster frame (PNG).
// Auth + ownership mirror the video route. Generated best-effort after render
// (see thumbnailService); 404 when no thumbnail exists yet.
router.get("/projects/:id/thumbnail", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const [project] = await db
    .select({ userId: projectsTable.userId })
    .from(projectsTable)
    .where(eq(projectsTable.id, id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Same Express-5 + spaces-in-path constraint as the video route: stream the
  // file manually rather than res.sendFile.
  const thumbPath = getThumbnailPath(RENDERS_DIR, id);
  if (!fs.existsSync(thumbPath)) {
    res.status(404).json({ error: "Thumbnail not available" });
    return;
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="project-${id}.png"`,
  );
  fs.createReadStream(thumbPath).pipe(res);
});

export default router;
