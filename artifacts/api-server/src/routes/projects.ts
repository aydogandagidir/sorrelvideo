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
  RENDERS_DIR,
} from "../services/renderService";
import { getThumbnailPath } from "../services/thumbnailService";
import {
  resolveSettings,
  assertRenderSettingsAllowed,
} from "../services/renderSettingsService";
import { enqueueRender, isQueueEnabled } from "../lib/renderQueue";
import {
  createRenderJob as createRenderJobRow,
  markFailed,
} from "../services/renderJobsService";
import {
  checkAndIncrementRenderCount,
  getUserPlan,
} from "../services/billingService";

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
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

  res.json(ListProjectsResponse.parse(serializeDates(projects)));
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

  res.json(GetProjectResponse.parse(serializeDates(project)));
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
  try {
    const [userRow] = await db
      .select({ stripeCustomerId: usersTable.stripeCustomerId })
      .from(usersTable)
      .where(eq(usersTable.id, req.user.id));
    const plan = await getUserPlan(userRow?.stripeCustomerId ?? null);
    assertRenderSettingsAllowed(settings, plan);
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
  // advance through queued → rendering → ready/failed/cancelled.
  const renderJobId = await createRenderJobRow({
    projectId: id,
    userId: req.user.id,
    backend: isQueueEnabled() ? "bullmq" : "inline",
    config: settings,
    format: settings.format,
  });

  // Durable enqueue when REDIS_URL is set; inline fire-and-forget otherwise.
  // If enqueue fails, release the claim so the project isn't stranded in
  // "rendering" and mark the ledger row failed.
  try {
    await enqueueRender(id, project.module, project.templateId, renderJobId);
  } catch (err) {
    await db
      .update(projectsTable)
      .set({ status: project.status })
      .where(eq(projectsTable.id, id));
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
