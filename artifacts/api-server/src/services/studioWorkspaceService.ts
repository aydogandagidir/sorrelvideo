/**
 * Studio workspace service (M9 studio-embed foundation).
 *
 * A generic, SANDBOXED per-project on-disk file store that the embedded
 * `@hyperframes/studio` editor's file-CRUD API will sit on. It is deliberately
 * route-agnostic and DB-less: the route layer owns auth / ownership / DB, then
 * passes the authenticated `userId` + `projectId` down here. Every method is
 * scoped to `<root>/<userId>/<projectId>/`, mirroring how render outputs live
 * under `RENDERS_DIR` (see renderService.ts).
 *
 * SECURITY: every caller-supplied relative path is funneled through
 * `safeResolve`, which rejects (throws an `Error` with `.status = 400`) any path
 * that escapes the project sandbox — `../` traversal, absolute paths, and
 * Windows drive-letter paths. There is no read/write/delete/rename code path
 * that touches disk without going through it first.
 */
import path from "path";
import fs from "fs/promises";
import { type Dirent } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Error thrown when a caller-supplied path escapes its project sandbox. Carries
 * an HTTP `status` of 400 so the (future) route layer can surface it directly
 * without a translation table — same shape the rest of the services use for
 * client errors.
 */
export class WorkspacePathError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/**
 * Root directory holding every user's studio workspaces, keyed
 * `<root>/<userId>/<projectId>/`. Resolved PER CALL (not memoized at module
 * load like RENDERS_DIR) so it always reflects the current
 * `STUDIO_WORKSPACE_DIR` — this keeps the service unit-testable by pointing the
 * env at an `os.tmpdir()` subdir from within a test. Defaults to a `dist/`
 * sibling of the renders dir so dev, prod, and the Docker image all resolve
 * without per-env config.
 */
export function studioWorkspaceRoot(): string {
  return process.env.STUDIO_WORKSPACE_DIR
    ? path.resolve(process.env.STUDIO_WORKSPACE_DIR)
    : path.resolve(__dirname, "../studio-workspaces");
}

/**
 * The sandbox root for a single project: `<root>/<userId>/<projectId>/`.
 *
 * `userId` and `projectId` are themselves run through `safeResolve` against the
 * global root, so a hostile id (e.g. a `userId` of `"../../etc"`) can never
 * widen the sandbox — the same traversal guard that protects relative file
 * paths also pins the project directory itself.
 */
export function resolveWorkspaceDir(userId: string, projectId: string): string {
  const root = studioWorkspaceRoot();
  const userDir = safeResolve(root, userId);
  return safeResolve(userDir, projectId);
}

/**
 * Resolve `relPath` against `root` and guarantee the result stays INSIDE
 * `root`. Used for every disk-touching operation in this service.
 *
 * Rejects (throws `WorkspacePathError`, status 400):
 * - absolute inputs (`/etc/passwd`, `C:\Windows`) — `path.isAbsolute`
 * - `..` traversal that climbs above the root
 * - Windows drive-relative inputs (`C:foo`) and the rooted forms above
 *
 * The check is done on the RELATIVE path from `root` to the resolved target:
 * if that relative path starts with `..` (escapes upward) or is itself
 * absolute (different drive on Windows), the input is rejected. An empty
 * `relPath` resolves to `root` itself, which is allowed (relative is "").
 */
export function safeResolve(root: string, relPath: string): string {
  if (typeof relPath !== "string") {
    throw new WorkspacePathError("Path must be a string");
  }
  // Reject absolute inputs up front. This catches POSIX `/etc/...`, Windows
  // `C:\...`, and UNC paths before they're resolved against the root (where
  // `path.resolve` would otherwise discard the root entirely).
  if (path.isAbsolute(relPath)) {
    throw new WorkspacePathError(`Absolute paths are not allowed: ${relPath}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  const rel = path.relative(resolvedRoot, target);
  // `..` (exact) or anything starting with `..` + separator means the target
  // climbed above the root. An absolute `rel` means a different Windows drive.
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new WorkspacePathError(
      `Path escapes the project workspace: ${relPath}`,
    );
  }
  return target;
}

/** Recursively collect every file (not directory) under `dir`, absolute paths. */
async function walkFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A missing workspace lists as empty rather than throwing — callers treat
    // "no files" and "no workspace" identically.
    if (isNotFound(err)) return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Read a `code` string off an unknown thrown value (Node's fs errors carry one,
 * e.g. `ENOENT`/`EEXIST`) without leaning on the ambient `NodeJS` namespace or
 * an `any` cast. Returns `undefined` for anything that isn't a `{ code: string }`.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const { code } = err as { code: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** True when an fs error is a "does not exist" (ENOENT). */
function isNotFound(err: unknown): boolean {
  return errorCode(err) === "ENOENT";
}

/** Normalize an OS-native path to POSIX-style (forward slashes). */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * List all files in a project's workspace as relative, POSIX-style paths
 * (sorted for determinism). Returns `[]` when the workspace does not exist.
 */
export async function listFiles(
  userId: string,
  projectId: string,
): Promise<string[]> {
  const dir = resolveWorkspaceDir(userId, projectId);
  const absoluteFiles = await walkFiles(dir);
  return absoluteFiles
    .map((abs) => toPosix(path.relative(dir, abs)))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Read a workspace file as UTF-8 text. Returns `null` when the file is absent
 * (so the route layer can answer 404 without a try/catch). Throws
 * `WorkspacePathError` (400) on a sandbox-escaping `relPath`.
 */
export async function readFile(
  userId: string,
  projectId: string,
  relPath: string,
): Promise<string | null> {
  const dir = resolveWorkspaceDir(userId, projectId);
  const target = safeResolve(dir, relPath);
  try {
    return await fs.readFile(target, "utf-8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Create or overwrite a workspace file (UTF-8), creating parent directories as
 * needed (`mkdir -p`). Throws `WorkspacePathError` (400) on a sandbox-escaping
 * `relPath`.
 */
export async function writeFile(
  userId: string,
  projectId: string,
  relPath: string,
  content: string,
): Promise<void> {
  const dir = resolveWorkspaceDir(userId, projectId);
  const target = safeResolve(dir, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
}

/**
 * Delete a workspace file. A missing file is a no-op (idempotent delete), so
 * `force: true` swallows ENOENT. Throws `WorkspacePathError` (400) on a
 * sandbox-escaping `relPath`.
 */
export async function deleteFile(
  userId: string,
  projectId: string,
  relPath: string,
): Promise<void> {
  const dir = resolveWorkspaceDir(userId, projectId);
  const target = safeResolve(dir, relPath);
  await fs.rm(target, { force: true });
}

/**
 * Move a workspace file from `fromRel` to `toRel`. BOTH paths are sandbox-
 * checked, so neither the source nor the destination can escape the project
 * dir. The destination's parent directories are created as needed. Throws
 * `WorkspacePathError` (400) on either path escaping.
 */
export async function renameFile(
  userId: string,
  projectId: string,
  fromRel: string,
  toRel: string,
): Promise<void> {
  const dir = resolveWorkspaceDir(userId, projectId);
  const from = safeResolve(dir, fromRel);
  const to = safeResolve(dir, toRel);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}

/**
 * Ensure a project's workspace exists, seeding the composition file the FIRST
 * time only. If the workspace directory already exists this is a no-op — it
 * will NOT overwrite a file the user has since edited. The seed mirrors the
 * render pipeline's shape: `seed.html` is written to `seed.entryFile` (see
 * `buildCompositionHtml` / `resolveEntryFile` in renderService.ts).
 */
export async function ensureWorkspace(
  userId: string,
  projectId: string,
  seed: { entryFile: string; html: string },
): Promise<void> {
  const dir = resolveWorkspaceDir(userId, projectId);
  try {
    // `mkdir` without `recursive` throws EEXIST if the dir is already there,
    // which is our "already seeded" signal — atomic, no separate stat/race.
    await fs.mkdir(dir, { recursive: false });
  } catch (err) {
    if (isDirExists(err)) return; // already initialized; leave edits untouched
    // The parent (`<root>/<userId>`) may not exist yet on a first-ever
    // workspace; create the full chain, then continue to seed.
    if (isNotFound(err)) {
      await fs.mkdir(dir, { recursive: true });
    } else {
      throw err;
    }
  }
  // entryFile goes through writeFile's safeResolve, so a hostile seed filename
  // is rejected exactly like any other write.
  await writeFile(userId, projectId, seed.entryFile, seed.html);
}

/** True when an fs error is an "already exists" (EEXIST). */
function isDirExists(err: unknown): boolean {
  return errorCode(err) === "EEXIST";
}
