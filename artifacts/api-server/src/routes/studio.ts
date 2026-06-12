/**
 * Studio file-server routes (M9 Phase 2).
 *
 * Serves the file-CRUD + preview + live-reload contract the EMBEDDED
 * `@hyperframes/studio` SPA calls, under `/api/studio/*` (the parent mounts this
 * router at `/api`, so the paths below start with `/studio`). Every route is
 * auth- and ownership-gated exactly like `routes/projects.ts` (401 / 403 / 404)
 * and rides entirely on the existing `studioWorkspaceService` — this layer owns
 * auth / ownership / DB, the service owns the sandboxed on-disk file store.
 *
 * SPEC-EXEMPT (intentional): these routes are consumed by the studio SPA's own
 * hardcoded fetch calls, NOT by Sorrel's OpenAPI-generated React Query hooks, so
 * they are deliberately absent from `openapi.yaml` — the same treatment the
 * OAuth redirect callbacks and the Stripe webhook get. Do NOT add them to the
 * spec; doing so would generate dead client hooks.
 *
 * EXPRESS 5 WILDCARD: this repo is on Express 5 (path-to-regexp v8), where a
 * bare `*` is rejected. File paths (compositions contain `/`) are matched with a
 * NAMED wildcard `/files/*splat`; `req.params.splat` arrives as a string array
 * that `splatPath()` rejoins into the workspace-relative path. A wrong wildcard
 * would 404 instead of reaching the handler — the route tests assert a wildcard
 * path returns 401 (not 404) to guard exactly that.
 *
 * BODY PARSERS are per-route only (never global): the text routes attach
 * `express.text(...)` and the JSON routes attach `express.json()` so the raw
 * composition bytes are never mangled and the global parser stack (which guards
 * the Stripe raw-body route) is left untouched.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express, {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  db,
  projectsTable,
  renderJobsTable,
  usersTable,
  type RenderJobRow,
  type RenderSettings,
} from "@workspace/db";
import {
  resolveWorkspaceDir,
  safeResolve,
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  renameFile,
  ensureWorkspace,
  WorkspacePathError,
} from "../services/studioWorkspaceService";
import {
  resolveSettings,
  assertRenderSettingsAllowed,
} from "../services/renderSettingsService";
import { buildCompositionHtml } from "../services/renderService";
import {
  enqueueRender,
  isQueueEnabled,
  removeQueuedRender,
  RenderAlreadyActiveError,
} from "../lib/renderQueue";
import {
  createRenderJob,
  markFailed,
  markCancelled,
  requestCancel,
} from "../services/renderJobsService";
import {
  checkAndIncrementRenderCount,
  getUserPlan,
} from "../services/billingService";
import { emitFileChange, subscribe } from "../lib/studioEvents";
import {
  prepareHyperframeLintBody,
  runHyperframeLint,
} from "@hyperframes/producer";

const router: IRouter = Router();

type ProjectRow = typeof projectsTable.$inferSelect;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Studio workspace seed: a self-contained `__timelines` composition saved as
 * the workspace ENTRY file. Newly-opened projects get this so the Studio's
 * timeline panel has a real timeline to drive; saving it back persists to
 * `projects.compositionHtml` (see `isEntryComposition` + the file-write routes),
 * so the next render uses the studio-authored document verbatim.
 */
const STUDIO_ENTRY_FILE = "index.html";
const STUDIO_SEED_COMPOSITION = "studio-default-timelines.html";

/**
 * Pick the first path that exists. Mirrors renderService's probe: esbuild
 * bundles this module to dist/, so the compositions dir differs between the
 * source layout, the prod Docker image, and dev. Probing keeps all three
 * working without per-env config.
 */
function firstExistingDir(candidates: string[], fallback: string): string {
  return candidates.find((p) => p && fs.existsSync(p)) ?? fallback;
}

const COMPOSITIONS_DIR = firstExistingDir(
  [
    path.resolve(__dirname, "compositions"),
    path.resolve(__dirname, "../compositions"),
    path.resolve(__dirname, "../src/compositions"),
    path.resolve(__dirname, "../../src/compositions"),
  ],
  path.resolve(__dirname, "../compositions"),
);

/** Read the seed `__timelines` composition HTML used to initialize a workspace. */
function readSeedComposition(): string {
  return fs.readFileSync(
    path.join(COMPOSITIONS_DIR, STUDIO_SEED_COMPOSITION),
    "utf-8",
  );
}

/**
 * True when a saved workspace path is the entry composition — the document a
 * render consumes. Saving it persists the bytes to `projects.compositionHtml`.
 * Both the seeded entry (`index.html`) and the legacy `composition.html` name
 * the render pipeline writes count, so a project authored either way round-trips.
 */
function isEntryComposition(relPath: string): boolean {
  const normalized = relPath.replace(/^\.\//, "");
  return normalized === STUDIO_ENTRY_FILE || normalized === "composition.html";
}

/**
 * Persist a saved entry-composition's HTML onto the project so the next render
 * uses the studio-authored document (buildCompositionHtml prefers a non-empty
 * compositionHtml). Owner-scoped UPDATE — the caller has already passed the
 * ownership gate, but scoping on userId too keeps the write tenant-safe.
 */
async function persistCompositionHtml(
  projectId: number,
  userId: string,
  html: string,
): Promise<void> {
  await db
    .update(projectsTable)
    .set({ compositionHtml: html })
    .where(
      and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)),
    );
}

/**
 * The Free/Pro plan for the authenticated user, read off their Stripe customer
 * mirror exactly like routes/projects.ts. Never reads `users.plan`.
 */
async function planForUser(userId: string): Promise<"free" | "pro"> {
  const [userRow] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return getUserPlan(userRow?.stripeCustomerId ?? null);
}

/**
 * Auth + ownership gate for the render-job routes, whose `:jobId` is a
 * render_jobs UUID (not a project id), so `loadOwnedProject` does not apply.
 * 401 unauthenticated → 404 missing → 403 not-owner. Returns the owned job row,
 * or null after having written the response.
 */
async function loadOwnedJob(
  req: Request,
  res: Response,
): Promise<RenderJobRow | null> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const raw = Array.isArray(req.params.jobId)
    ? req.params.jobId[0]
    : req.params.jobId;
  const [job] = await db
    .select()
    .from(renderJobsTable)
    .where(eq(renderJobsTable.id, raw));
  if (!job) {
    res.status(404).json({ error: "Render job not found" });
    return null;
  }
  if (job.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return job;
}

/**
 * Reconstruct the workspace-relative file path from an Express 5 named wildcard.
 * A named wildcard (`*splat`) matches the tail as a string ARRAY at runtime
 * (e.g. `["assets", "logo.svg"]` for `.../files/assets/logo.svg`); join with `/`
 * to the POSIX-style relative path the workspace service expects. Mirrors the
 * `Array.isArray(req.params.<name>)` idiom already used in `routes/storage.ts`,
 * so no cast is needed and no `any` is introduced. An absent match yields `""`,
 * which the service treats as the workspace root.
 */
function splatPath(req: Request): string {
  const raw = req.params.splat;
  if (Array.isArray(raw)) return raw.join("/");
  return raw ?? "";
}

/**
 * Auth + ownership gate, copied verbatim from `routes/projects.ts`:
 * 401 unauthenticated → 400 bad id → 404 missing → 403 not-owner. Returns the
 * owned project on success, or `null` after having already written the response
 * (the caller just `return`s). The authenticated `userId` is read off
 * `req.user.id` AFTER `isAuthenticated()` narrows the request — never before.
 */
async function loadOwnedProject(
  req: Request,
  res: Response,
): Promise<ProjectRow | null> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return null;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }

  if (project.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  return project;
}

/** Per-route raw-text parser for file writes (any content-type, 5 MB cap). */
const textBody = express.text({ type: () => true, limit: "5mb" });
/** Per-route JSON parser for the rename / duplicate metadata routes. */
const jsonBody = express.json();

/**
 * Coerce a parsed request body to the raw file text we persist. `express.text`
 * yields a string (`""` for an empty body). Belt-and-braces: the app-level
 * `express.json()` (app.ts) runs first and WOULD parse a body sent as
 * `application/json` into an object/array before our `textBody` sees it — in
 * that case re-serialize so a `.json` file's content is never silently dropped.
 * `null`/`undefined` (no body) → `""`.
 */
function bodyToText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body == null) return "";
  if (typeof body === "object") return JSON.stringify(body);
  return String(body);
}

/**
 * GET /api/studio/projects — userId-scoped project list for the studio picker.
 * Mirrors the projects list query but returns only the `{ id, name }` shape the
 * studio expects, with `id` STRINGIFIED (studio uses string ids; Sorrel's are
 * serial ints — the id-type seam noted in the spec).
 */
router.get("/studio/projects", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const projects = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.userId, req.user.id))
    .orderBy(projectsTable.updatedAt);

  res.json({
    projects: projects.map((p) => ({ id: String(p.id), name: p.name })),
  });
});

/**
 * GET /api/studio/projects/:id — open (and lazily seed) a project's workspace.
 * Seeds the workspace the FIRST time only, writing the entry composition
 * (`index.html`) so the embedded Studio has a `__timelines` document its
 * timeline panel can read/preview/edit. Returns the file list + on-disk dir.
 *
 * Seed contents: a project that already has a studio-authored document
 * (`compositionHtml` set) opens with that HTML so re-opens are faithful; a fresh
 * project is seeded from `studio-default-timelines.html` (the __timelines seed).
 * Saving the entry composition back persists it to `compositionHtml` (see the
 * file-write routes), closing the loop so the next render uses it verbatim.
 */
router.get("/studio/projects/:id", async (req, res): Promise<void> => {
  const project = await loadOwnedProject(req, res);
  if (!project) return;

  // Seed the workspace the first time it's opened. A studio-authored doc
  // (compositionHtml set) opens verbatim; a fresh `studio` project gets the
  // __timelines editor seed; ANY OTHER module (website-showcase, a registry
  // template) keeps its content in compositionVars with compositionHtml=null —
  // seed its vars-substituted REAL composition via buildCompositionHtml so
  // editing/saving doesn't blank it (which would corrupt the project, since a
  // saved compositionHtml then wins at render time and the original is lost).
  const seedHtml =
    typeof project.compositionHtml === "string" &&
    project.compositionHtml.length > 0
      ? project.compositionHtml
      : project.module === "studio"
        ? readSeedComposition()
        : await buildCompositionHtml(project);

  try {
    await ensureWorkspace(project.userId, String(project.id), {
      entryFile: STUDIO_ENTRY_FILE,
      html: seedHtml,
    });
    // Self-heal: a pre-existing workspace (persistent volume survives deploys;
    // ensureWorkspace never rewrites) may still hold an OLD default seed that
    // predates the player contract — refresh it as long as the user never
    // saved their own document.
    const entry = await readFile(
      project.userId,
      String(project.id),
      STUDIO_ENTRY_FILE,
    );
    if (entry !== null) await upgradeStaleSeed(project, entry);
    res.json({
      files: await listFiles(project.userId, String(project.id)),
      dir: resolveWorkspaceDir(project.userId, String(project.id)),
    });
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * GET /api/studio/projects/:id/files/*splat — read a workspace file. A missing
 * file is a clean 404 (the studio client treats 404 as empty content); a present
 * one returns `{ content }`.
 */
router.get(
  "/studio/projects/:id/files/*splat",
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    try {
      const content = await readFile(
        project.userId,
        String(project.id),
        splatPath(req),
      );
      if (content === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      res.json({ content });
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

/**
 * PUT /api/studio/projects/:id/files/*splat — create-or-overwrite a file from a
 * raw-text body, then emit a `file-change` so other Studio tabs hot-reload. When
 * the saved path is the entry composition, the bytes are also persisted to
 * `projects.compositionHtml` so the next render uses the studio-authored doc.
 */
router.put(
  "/studio/projects/:id/files/*splat",
  textBody,
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    const relPath = splatPath(req);
    const content = bodyToText(req.body);
    try {
      await writeFile(project.userId, String(project.id), relPath, content);
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (isEntryComposition(relPath)) {
      await persistCompositionHtml(project.id, project.userId, content);
    }
    emitFileChange(project.userId, relPath);
    res.status(200).json({ ok: true });
  },
);

/**
 * POST /api/studio/projects/:id/files/*splat — identical to PUT
 * (create-or-overwrite); the studio uses POST for new files, PUT for saves. Like
 * PUT, a save to the entry composition is mirrored to `projects.compositionHtml`.
 */
router.post(
  "/studio/projects/:id/files/*splat",
  textBody,
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    const relPath = splatPath(req);
    const content = bodyToText(req.body);
    try {
      await writeFile(project.userId, String(project.id), relPath, content);
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (isEntryComposition(relPath)) {
      await persistCompositionHtml(project.id, project.userId, content);
    }
    emitFileChange(project.userId, relPath);
    res.status(200).json({ ok: true });
  },
);

/**
 * DELETE /api/studio/projects/:id/files/*splat — remove a file (idempotent in
 * the service) and emit a `file-change`. 204 No Content on success.
 */
router.delete(
  "/studio/projects/:id/files/*splat",
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    const relPath = splatPath(req);
    try {
      await deleteFile(project.userId, String(project.id), relPath);
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    emitFileChange(project.userId, relPath);
    res.sendStatus(204);
  },
);

/**
 * PATCH /api/studio/projects/:id/files/*splat — rename a file. Body
 * `{ newPath: string }` (non-empty). Emits a `file-change` for BOTH the old and
 * new paths so the tree drops the source and picks up the destination.
 */
router.patch(
  "/studio/projects/:id/files/*splat",
  jsonBody,
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    const body: unknown = req.body;
    const newPath =
      typeof body === "object" && body !== null && "newPath" in body
        ? (body as { newPath: unknown }).newPath
        : undefined;
    if (typeof newPath !== "string" || newPath.length === 0) {
      res.status(400).json({ error: "newPath must be a non-empty string" });
      return;
    }

    const oldPath = splatPath(req);
    try {
      await renameFile(project.userId, String(project.id), oldPath, newPath);
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    emitFileChange(project.userId, oldPath);
    emitFileChange(project.userId, newPath);
    res.status(200).json({ ok: true });
  },
);

/**
 * Derive a `-copy` sibling path: `dir/name.ext` → `dir/name-copy.ext`,
 * `dir/name` (no extension) → `dir/name-copy`. Keeps the original directory and
 * extension so the duplicate lands beside its source and stays the same type.
 */
function copyPathFor(srcPath: string): string {
  const slash = srcPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : srcPath.slice(0, slash + 1);
  const base = slash === -1 ? srcPath : srcPath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  // A leading dot (dotfile, dot === 0) is part of the name, not an extension.
  if (dot <= 0) return `${dir}${base}-copy`;
  return `${dir}${base.slice(0, dot)}-copy${base.slice(dot)}`;
}

/**
 * POST /api/studio/projects/:id/duplicate-file — copy a file to a `-copy`
 * sibling. Body `{ path: string }`. 404 if the source is absent. Returns the new
 * path and emits a `file-change` for it.
 */
router.post(
  "/studio/projects/:id/duplicate-file",
  jsonBody,
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    const body: unknown = req.body;
    const srcPath =
      typeof body === "object" && body !== null && "path" in body
        ? (body as { path: unknown }).path
        : undefined;
    if (typeof srcPath !== "string" || srcPath.length === 0) {
      res.status(400).json({ error: "path must be a non-empty string" });
      return;
    }

    try {
      const content = await readFile(
        project.userId,
        String(project.id),
        srcPath,
      );
      if (content === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      const newPath = copyPathFor(srcPath);
      await writeFile(project.userId, String(project.id), newPath, content);
      emitFileChange(project.userId, newPath);
      res.status(200).json({ path: newPath });
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

/**
 * POST /api/studio/projects/:id/upload — asset upload. STUB for this wave: a
 * 501 keeps the multipart dependency out of the tree until the upload story is
 * built out.
 *
 * TODO(M9 Phase 2b): multipart upload via multer (memory storage, field
 * `file[]`) → write each asset into the workspace, return `{ files, skipped,
 * invalid }`.
 */
router.post("/studio/projects/:id/upload", async (req, res): Promise<void> => {
  const project = await loadOwnedProject(req, res);
  if (!project) return;
  res.status(501).json({ error: "Asset upload not yet supported" });
});

/**
 * GET /api/studio/projects/:id/preview/comp/*splat — serve a workspace file as
 * HTML for the studio preview iframe. 404 when absent. Sent via `res.send`
 * (NOT `res.sendFile` — Express 5's send() spuriously 404s absolute paths with
 * spaces, which this repo's path has) with `no-store` so the preview always
 * reflects the latest saved edit.
 */
router.get(
  "/studio/projects/:id/preview/comp/*splat",
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    try {
      const html = await readFile(
        project.userId,
        String(project.id),
        splatPath(req),
      );
      if (html === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

/**
 * A stale DEFAULT seed: the workspace entry came from an older
 * studio-default-timelines.html (it carries the seed's composition id but
 * predates the full TimelineLike playback contract — `isActive` is the marker)
 * AND the user never saved their own document (compositionHtml null). Studio
 * workspaces can outlive deploys (persistent volume), and ensureWorkspace
 * never touches an existing dir — so without this check a contract upgrade to
 * the seed would never reach previously-opened projects (player stuck at 0:00).
 */
function isStaleDefaultSeed(html: string, project: ProjectRow): boolean {
  return (
    project.module === "studio" &&
    (typeof project.compositionHtml !== "string" ||
      project.compositionHtml.length === 0) &&
    html.includes('data-composition-id="studio-default"') &&
    !html.includes("isActive")
  );
}

/**
 * Refresh a never-customized workspace entry that still holds a stale default
 * seed. Returns the HTML to use (fresh seed when upgraded, original otherwise).
 */
async function upgradeStaleSeed(
  project: ProjectRow,
  entryHtml: string,
): Promise<string> {
  if (!isStaleDefaultSeed(entryHtml, project)) return entryHtml;
  const fresh = readSeedComposition();
  await writeFile(project.userId, String(project.id), STUDIO_ENTRY_FILE, fresh);
  return fresh;
}

/**
 * Resolve the project's ENTRY composition HTML for preview/lint, seeding the
 * workspace first if it was never opened (same seed precedence as the open
 * route: studio-authored compositionHtml → studio timeline seed → the project's
 * vars-substituted real composition). Returns null when no entry exists even
 * after seeding (the caller 404s).
 */
async function resolveEntryHtml(project: ProjectRow): Promise<string | null> {
  const seedHtml =
    typeof project.compositionHtml === "string" &&
    project.compositionHtml.length > 0
      ? project.compositionHtml
      : project.module === "studio"
        ? readSeedComposition()
        : await buildCompositionHtml(project);
  await ensureWorkspace(project.userId, String(project.id), {
    entryFile: STUDIO_ENTRY_FILE,
    html: seedHtml,
  });
  const entry = await readFile(
    project.userId,
    String(project.id),
    STUDIO_ENTRY_FILE,
  );
  if (entry !== null) return upgradeStaleSeed(project, entry);
  // Legacy workspaces seeded by the render pipeline used composition.html.
  return readFile(project.userId, String(project.id), "composition.html");
}

/**
 * GET /api/studio/projects/:id/preview — the studio's MASTER preview iframe
 * source: the workspace entry composition as a full HTML document. Seeds the
 * workspace when missing so a deep link straight to the editor previews too.
 * `no-store` so every saved edit is reflected on the next iframe reload.
 */
router.get(
  "/studio/projects/:id/preview",
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    try {
      const html = await resolveEntryHtml(project);
      if (html === null) {
        res.status(404).json({ error: "No composition to preview" });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

/** Content types for workspace files the preview iframe / asset panel loads. */
const PREVIEW_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

/**
 * GET /api/studio/projects/:id/preview/*splat — serve any workspace file for
 * the preview iframe's sub-resources and the asset/media panels. Registered
 * AFTER `/preview/comp/*splat` so composition previews keep their dedicated
 * handler. Raw byte read (assets may be binary) behind the same
 * `safeResolve` traversal guard the workspace service uses everywhere.
 */
router.get(
  "/studio/projects/:id/preview/*splat",
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    const rel = splatPath(req);
    try {
      const abs = safeResolve(
        resolveWorkspaceDir(project.userId, String(project.id)),
        rel,
      );
      const bytes = await fs.promises.readFile(abs);
      const ext = path.extname(rel).slice(1).toLowerCase();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Type",
        PREVIEW_MIME[ext] ?? "application/octet-stream",
      );
      res.send(bytes);
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
        return;
      }
      throw err;
    }
  },
);

/**
 * GET /api/studio/projects/:id/lint — run the engine's composition linter
 * (producer `runHyperframeLint`) on the project's entry composition and return
 * the full result; the studio's lint modal reads `findings[]`
 * ({severity,message,file,fixHint}).
 */
router.get("/studio/projects/:id/lint", async (req, res): Promise<void> => {
  const project = await loadOwnedProject(req, res);
  if (!project) return;

  try {
    const html = await resolveEntryHtml(project);
    if (html === null) {
      res.status(404).json({ error: "No composition to lint" });
      return;
    }
    const prepared = prepareHyperframeLintBody({
      html,
      entryFile: STUDIO_ENTRY_FILE,
    });
    if ("error" in prepared) {
      res.status(400).json({ error: prepared.error });
      return;
    }
    // `runHyperframeLint` became async in producer 0.6.91 — the missing await
    // serialized a pending Promise as `{}` (tsc can't catch it: res.json(any)).
    res.json(await runHyperframeLint(prepared.prepared));
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * GET /api/studio/events — Server-Sent Events stream the studio subscribes to
 * for live reload. Registered in the in-process `studioEvents` registry keyed by
 * `userId`; emits an initial `: connected` comment to flush headers, then
 * `file-change` events as the file routes mutate the workspace. Cleaned up on
 * the request `close`.
 */
router.get("/studio/events", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const unsubscribe = subscribe(req.user.id, res);

  // Initial comment line: flushes headers through any proxy and confirms the
  // stream is live before the first real event.
  res.write(": connected\n\n");

  req.on("close", () => {
    unsubscribe();
    res.end();
  });
});

/* ------------------------------------------------------------------ *
 * Studio render adapter (M9 Phase 4 §1e).                            *
 *                                                                    *
 * Thin wrappers that drive Sorrel's EXISTING render pipeline from the *
 * studio's render-queue contract. They reuse the same gate            *
 * (resolveSettings + getUserPlan + assertRenderSettingsAllowed), the  *
 * same quota (checkAndIncrementRenderCount), the same ledger          *
 * (render_jobs via renderJobsService) and the same trigger            *
 * (enqueueRender) as `routes/projects.ts` — no parallel pipeline. All  *
 * routes stay auth + ownership gated and userId-scoped.               *
 * ------------------------------------------------------------------ */

/** Terminal render-job states — the SSE stream closes once one is reached. */
const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled"]);

/**
 * Pull a `{ fps, quality, format, resolution, transparent, watermark,
 * transitions }` partial off an untrusted JSON body without `any` — the same
 * shape `PATCH /projects/:id/render-settings` accepts, so a render started from
 * the embedded studio honors every Pro lever (transparent / watermark removal /
 * multi-transition) exactly like `POST /projects/:id/render`. Each field is read
 * as `unknown` and forwarded to `resolveSettings`, which coerces/validates it
 * (unknown values fall back to the defaults), so a malformed body degrades to the
 * default render rather than 500; `assertRenderSettingsAllowed` then re-gates the
 * resolved object so Pro-only knobs stay gated.
 */
function settingsFromBody(body: unknown): Partial<RenderSettings> {
  if (typeof body !== "object" || body === null) return {};
  const b = body as Record<string, unknown>;
  // resolveSettings re-validates every field against its allowed set, so we only
  // forward candidate values under the right keys (typeof-narrowed to satisfy the
  // typed signature; out-of-range values fall back to defaults downstream).
  const out: Partial<RenderSettings> = {};
  if (typeof b.fps === "number") out.fps = b.fps as RenderSettings["fps"];
  if (typeof b.quality === "string")
    out.quality = b.quality as RenderSettings["quality"];
  if (typeof b.format === "string")
    out.format = b.format as RenderSettings["format"];
  if (typeof b.resolution === "string")
    out.resolution = b.resolution as RenderSettings["resolution"];
  if (typeof b.transparent === "boolean") out.transparent = b.transparent;
  if (typeof b.watermark === "boolean") out.watermark = b.watermark;
  // transitions is forwarded when it's an array (resolveSettings keeps it only
  // for an array; the Pro gate then rejects >1 for Free). Mirrors the
  // render-settings body shape rather than parsing each element here.
  if (Array.isArray(b.transitions))
    out.transitions = b.transitions as RenderSettings["transitions"];
  return out;
}

/**
 * Filename for a render-job artifact: the basename of the persisted output path
 * when present (e.g. `output.webm`, or the `frames` dir for png-sequence), else
 * a sensible default derived from the snapshot format. Never returns a full path.
 */
function renderFilename(job: RenderJobRow): string {
  if (job.outputPath) return path.basename(job.outputPath);
  const format = resolveSettings(job.config ?? null).format;
  if (format === "png-sequence") return "frames";
  return `output.${format}`;
}

/** Byte size of a ready artifact, or undefined when absent / not a plain file. */
function artifactSize(job: RenderJobRow): number | undefined {
  if (!job.outputPath) return undefined;
  try {
    const stat = fs.statSync(job.outputPath);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST /api/studio/projects/:id/render — start a render from the studio's
 * `{ fps, quality, format, resolution? }` body. Re-gates the supplied config
 * (resolveSettings + plan + assertRenderSettingsAllowed → 403 on a Pro-only
 * knob), atomically claims the project (409 to a concurrent caller), burns quota
 * (403 on the Free cap, claim released), persists the resolved settings so the
 * executor renders with them, opens a render_jobs row, enqueues, and returns
 * `{ jobId }`. Byte-for-byte the same pipeline as POST /projects/:id/render.
 */
router.post(
  "/studio/projects/:id/render",
  jsonBody,
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;
    const userId = project.userId;

    // Resolve + gate the studio-supplied config first (read-only, so a 403 here
    // costs nothing and stays before the claim).
    const settings = resolveSettings(settingsFromBody(req.body));
    try {
      const plan = await planForUser(userId);
      assertRenderSettingsAllowed(settings, plan);
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

    // Atomically claim the render — the conditional UPDATE is the concurrency
    // guard (one winner out of a non-rendering state; 0 rows → already rendering).
    const [claimed] = await db
      .update(projectsTable)
      .set({ status: "rendering", renderError: null })
      .where(
        and(eq(projectsTable.id, project.id), ne(projectsTable.status, "rendering")),
      )
      .returning();
    if (!claimed) {
      res.status(409).json({ error: "Render already in progress" });
      return;
    }

    // Quota AFTER the claim so a race loser never burns a render. Release the
    // claim back to the prior status on a Free-cap rejection (not a failure).
    try {
      await checkAndIncrementRenderCount(userId);
    } catch (err) {
      await db
        .update(projectsTable)
        .set({ status: project.status })
        .where(eq(projectsTable.id, project.id));
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

    // Persist the studio-chosen settings so the executor (which re-reads
    // projects.render_settings at render time) renders with exactly this config.
    await db
      .update(projectsTable)
      .set({ renderSettings: settings })
      .where(eq(projectsTable.id, project.id));

    // Open the ledger row, then enqueue (durable when REDIS_URL is set, inline
    // fire-and-forget otherwise). On enqueue failure, release the claim and mark
    // the row failed so the project isn't stranded in "rendering".
    const jobId = await createRenderJob({
      projectId: project.id,
      userId,
      backend: isQueueEnabled() ? "bullmq" : "inline",
      config: settings,
      format: settings.format,
    });

    try {
      await enqueueRender(project.id, project.module, project.templateId, jobId);
    } catch (err) {
      await db
        .update(projectsTable)
        .set({ status: project.status })
        .where(eq(projectsTable.id, project.id));
      // Transient: the previous render of this project is still finishing (its
      // BullMQ job lock is held), so this attempt was never queued. Release the
      // claim, cancel this never-run ledger row, and 409 so the client retries —
      // never strand "rendering". (See routes/projects.ts for the same handling.)
      if (err instanceof RenderAlreadyActiveError) {
        await markCancelled(jobId).catch(() => undefined);
        res.status(409).json({ error: "Render already in progress" });
        return;
      }
      await markFailed(
        jobId,
        err instanceof Error ? err.message : String(err),
      ).catch(() => undefined);
      req.log.error({ projectId: project.id, err }, "Failed to enqueue render");
      res
        .status(503)
        .json({ error: "Could not start render. Please try again." });
      return;
    }

    res.status(202).json({ jobId });
  },
);

/**
 * GET /api/studio/projects/:id/renders — the project's render-job history mapped
 * to the studio's `{ renders: [{ id, filename, createdAt, size?, status }] }`
 * shape, newest first. `filename`/`size` come from the persisted artifact path.
 */
router.get(
  "/studio/projects/:id/renders",
  async (req, res): Promise<void> => {
    const project = await loadOwnedProject(req, res);
    if (!project) return;

    const jobs = await db
      .select()
      .from(renderJobsTable)
      .where(eq(renderJobsTable.projectId, project.id))
      .orderBy(desc(renderJobsTable.createdAt));

    res.json({
      renders: jobs.map((job) => {
        const size = artifactSize(job);
        return {
          id: job.id,
          filename: renderFilename(job),
          createdAt: job.createdAt.toISOString(),
          status: job.status,
          ...(size !== undefined ? { size } : {}),
        };
      }),
    });
  },
);

/**
 * GET /api/studio/render/:jobId/progress — Server-Sent Events stream of a render
 * job's progress. Polls the `render_jobs` row every ~1s and emits a named
 * `progress` event `{ progress, stage, status, error }`; closes once the job
 * reaches a terminal state (ready/failed/cancelled). Owner-scoped via the
 * initial `loadOwnedJob` gate (401/404/403). Cleaned up on request `close`.
 */
router.get(
  "/studio/render/:jobId/progress",
  async (req, res): Promise<void> => {
    const job = await loadOwnedJob(req, res);
    if (!job) return;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");

    let closed = false;
    // A holder (not a bare `let`) so `finish` can clear the interval before the
    // poll loop assigns it — without a temporal-dead-zone access and without
    // tripping prefer-const on a single-assignment `let`.
    const timerRef: { current: ReturnType<typeof setInterval> | undefined } = {
      current: undefined,
    };

    const send = (row: RenderJobRow): void => {
      const payload = {
        progress: row.progress,
        stage: row.status,
        status: row.status,
        ...(row.error ? { error: row.error } : {}),
      };
      res.write(`event: progress\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (timerRef.current) clearInterval(timerRef.current);
      res.end();
    };

    // Emit the current state immediately; if it's already terminal, close.
    send(job);
    if (TERMINAL_STATUSES.has(job.status)) {
      finish();
      return;
    }

    timerRef.current = setInterval(() => {
      void (async () => {
        if (closed) return;
        const [row] = await db
          .select()
          .from(renderJobsTable)
          .where(eq(renderJobsTable.id, job.id));
        if (!row) {
          finish();
          return;
        }
        send(row);
        if (TERMINAL_STATUSES.has(row.status)) finish();
      })().catch(() => finish());
    }, 1000);

    req.on("close", finish);
  },
);

/**
 * DELETE /api/studio/render/:jobId — request cancellation of a render job.
 * Owner-scoped via `loadOwnedJob`, then `requestCancel` flags the row (the
 * running worker observes the flag in its progress callback and rolls the
 * project back to draft) and `removeQueuedRender` best-effort drops a still-
 * queued job so it never starts. 200 `{ ok: true }`.
 */
router.delete("/studio/render/:jobId", async (req, res): Promise<void> => {
  const job = await loadOwnedJob(req, res);
  if (!job) return;

  await requestCancel(job.id, job.userId);
  await removeQueuedRender(job.projectId);

  res.status(200).json({ ok: true });
});

export default router;
