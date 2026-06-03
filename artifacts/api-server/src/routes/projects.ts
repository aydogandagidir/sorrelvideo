import fs from "fs";
import { Router, type IRouter } from "express";
import { and, eq, ne } from "drizzle-orm";
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
import {
  enqueueRender,
  isQueueEnabled,
  removeQueuedRender,
  RenderAlreadyActiveError,
} from "../lib/renderQueue";
import { selectBackend } from "../lib/renderBackend";
import {
  createRenderJob as createRenderJobRow,
  markFailed,
  markCancelled,
  requestCancel,
  getLatestJobForProject,
} from "../services/renderJobsService";
import {
  checkAndIncrementRenderCount,
  checkAndIncrementDistributedRenderCount,
  getUserPlan,
} from "../services/billingService";
import { findUnsafeCompositionVar } from "../lib/compositionVars";

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

  // Atomically claim the render. The conditional UPDATE is the concurrency guard:
  // only one request can flip a project out of a non-rendering state, so two
  // concurrent calls can't both start a render. 0 rows → already rendering.
  const [claimed] = await db
    .update(projectsTable)
    .set({ status: "rendering", renderError: null })
    .where(and(eq(projectsTable.id, id), ne(projectsTable.status, "rendering")))
    .returning();

  if (!claimed) {
    res.status(409).json({ error: "Render already in progress" });
    return;
  }

  // Quota AFTER the claim so the race loser never burns a render. On rejection,
  // release the claim back to the prior status (a quota block isn't a failure).
  try {
    await checkAndIncrementRenderCount(req.user.id);
  } catch (err) {
    await db
      .update(projectsTable)
      .set({ status: project.status })
      .where(eq(projectsTable.id, id));
    const e = err as { reason?: string; message?: string };
    if (e.reason === "upgrade_required") {
      res.status(403).json({
        error: e.message ?? "Render limit reached",
        reason: "upgrade_required",
      });
      return;
    }
    throw err;
  }

  // Re-gate the persisted render settings at render time (defense in depth — a
  // user who downgraded after saving a Pro config must not render it). On a
  // gate failure, release the claim back to the prior status (not a render
  // failure) and 403, byte-identical to the quota / premium-template rejections.
  const settings = resolveSettings(project.renderSettings);
  const [planRow] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id));
  const plan = await getUserPlan(planRow?.stripeCustomerId ?? null);
  try {
    assertRenderSettingsAllowed(settings, plan);
    // Distributed (Lambda) renders carry a separate monthly cap — even for Pro,
    // since they cost real money. Only enforced when this render actually routes
    // to Lambda (RENDER_BACKEND=lambda + AWS env + Pro); inline/bullmq unaffected.
    if (selectBackend(plan) === "lambda") {
      await checkAndIncrementDistributedRenderCount(req.user.id);
    }
  } catch (err) {
    const e = err as { reason?: string; message?: string };
    if (e.reason === "upgrade_required") {
      await db
        .update(projectsTable)
        .set({ status: project.status })
        .where(eq(projectsTable.id, id));
      res.status(403).json({
        error: e.message ?? "Upgrade required",
        reason: "upgrade_required",
      });
      return;
    }
    throw err;
  }

  // Open a render-job ledger row before enqueueing so the pipeline has an id to
  // advance through queued → rendering → ready/failed/cancelled. If the INSERT
  // fails (e.g. the render_jobs table is missing), release the claim back to the
  // prior status so the project is never stranded in "rendering", then 503.
  let renderJobId: string;
  try {
    renderJobId = await createRenderJobRow({
      projectId: id,
      userId: req.user.id,
      backend: isQueueEnabled() ? "bullmq" : "inline",
      config: settings,
      format: settings.format,
    });
  } catch (err) {
    await db
      .update(projectsTable)
      .set({ status: project.status })
      .where(eq(projectsTable.id, id));
    req.log.error({ projectId: id, err }, "Failed to open render-job ledger row");
    res
      .status(503)
      .json({ error: "Could not start render. Please try again." });
    return;
  }

  // Durable enqueue when REDIS_URL is set; inline fire-and-forget otherwise.
  // If enqueue fails, release the claim so the project isn't stranded in
  // "rendering" and resolve the just-opened ledger row.
  try {
    await enqueueRender(id, project.module, project.templateId, renderJobId, plan);
  } catch (err) {
    await db
      .update(projectsTable)
      .set({ status: project.status })
      .where(eq(projectsTable.id, id));
    // RenderAlreadyActiveError is transient, not a failure: the PREVIOUS render
    // of this project is still finishing (its BullMQ job lock is held), so this
    // attempt was never queued. Release the claim, mark this attempt's ledger
    // row cancelled (it never ran), and 409 so the client retries shortly —
    // exactly like losing the atomic claim. The burned quota increment is the
    // accepted cost of a near-simultaneous double render (rare; the previous
    // render still completes).
    if (err instanceof RenderAlreadyActiveError) {
      await markCancelled(renderJobId).catch(() => undefined);
      res.status(409).json({ error: "Render already in progress" });
      return;
    }
    await markFailed(
      renderJobId,
      err instanceof Error ? err.message : String(err),
    ).catch(() => undefined);
    req.log.error({ projectId: id, err }, "Failed to enqueue render");
    res.status(503).json({ error: "Could not start render. Please try again." });
    return;
  }

  res.status(202).json(GetProjectResponse.parse(serializeDates(claimed)));
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

  // png-sequence renders an OUTPUT DIRECTORY of frames, not a streamable file.
  // Download-as-zip is deferred (M-later); surface a clear 409 for now.
  if (format === "png-sequence") {
    res.status(409).json({
      error:
        "This project rendered a PNG sequence; download-as-zip is not available yet.",
    });
    return;
  }

  // Per-format MIME + extension for the Content-Type / Content-Disposition.
  const VIDEO_MIME: Record<"mp4" | "webm" | "mov", string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
  };
  const EXT: Record<"mp4" | "webm" | "mov", string> = {
    mp4: "mp4",
    webm: "webm",
    mov: "mov",
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
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : total - 1;
    if (start >= total || end >= total) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`);
      res.end();
      return;
    }
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
    mergedVars = {
      ...(project.compositionVars ?? {}),
      ...(overrides as Record<string, string>),
    };
  }

  const html = await buildCompositionHtml({
    id: project.id,
    userId: project.userId,
    module: project.module,
    compositionVars: mergedVars,
  });

  // Preview must reflect live edits, never a cached copy.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // A string body is safe to res.send — the Express-5 spaces-in-path issue only
  // affects res.sendFile, which we deliberately avoid here.
  res.send(html);
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
