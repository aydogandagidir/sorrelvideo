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
import express, {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { eq } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import {
  resolveWorkspaceDir,
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  renameFile,
  ensureWorkspace,
  WorkspacePathError,
} from "../services/studioWorkspaceService";
import {
  buildCompositionHtml,
  resolveEntryFile,
} from "../services/renderService";
import { emitFileChange, subscribe } from "../lib/studioEvents";

const router: IRouter = Router();

type ProjectRow = typeof projectsTable.$inferSelect;

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
 * Seeds the workspace the FIRST time only with the project's current `__hf`
 * composition HTML, then returns the file list + on-disk dir.
 *
 * TODO(M9 Phase 4): seed a __timelines entry composition instead of the current
 * `__hf` composition once the studio timeline migration lands.
 */
router.get("/studio/projects/:id", async (req, res): Promise<void> => {
  const project = await loadOwnedProject(req, res);
  if (!project) return;

  try {
    await ensureWorkspace(project.userId, String(project.id), {
      entryFile: resolveEntryFile(project.module),
      html: await buildCompositionHtml(project),
    });
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
 * raw-text body, then emit a `file-change` so other Studio tabs hot-reload.
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
    emitFileChange(project.userId, relPath);
    res.status(200).json({ ok: true });
  },
);

/**
 * POST /api/studio/projects/:id/files/*splat — identical to PUT
 * (create-or-overwrite); the studio uses POST for new files, PUT for saves.
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

export default router;
