import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

/**
 * The Hyperframes producer captures every frame to a per-render SCRATCH
 * directory named `work-<jobId>-<hash>` inside the project's render dir, and
 * encodes from there. Those frames are pure intermediates — the served artifact
 * is always written OUTSIDE the scratch dir (single-file formats →
 * `<dir>/output.<ext>`, png-sequence → `<dir>/frames`). Nothing reads `work-*`
 * after a render finishes.
 *
 * renderService never deleted them, so EVERY render (success or failure) leaked
 * its frames onto the volume. On a small Railway disk that accumulates until a
 * render dies mid-encode with **"No space left on device"** — which is exactly
 * what repeatedly killed project 17 (the earlier "moov atom not found" was the
 * same disk-full failure: the mp4 could never be finalized). Reclaiming the
 * scratch dirs is the permanent fix; matching only the `work-` prefix keeps
 * every real output safe.
 */
const WORK_DIR_PREFIX = "work-";

/**
 * Delete the engine's `work-*` scratch dirs under ONE project's render dir.
 * Returns the number removed. Best-effort and NEVER throws — it runs in
 * executeRender's `finally`, so a cleanup error must not mask (or replace) the
 * render's real outcome.
 */
export async function cleanupProjectWorkDirs(
  projectDir: string,
): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  } catch {
    return 0; // dir missing / never created — nothing to reclaim
  }

  let removed = 0;
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith(WORK_DIR_PREFIX)) continue;
    const target = path.join(projectDir, ent.name);
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn({ err, target }, "Could not remove render work dir");
    }
  }
  return removed;
}

/**
 * Boot-time sweep: reclaim leaked `work-*` scratch dirs across EVERY project
 * under the renders root. Run this at process start BEFORE the render worker can
 * begin draining a persisted job — at that instant no render is in flight (the
 * previous process's inline renders died with it), so any `work-*` is an orphan
 * from a render that crashed or filled the disk before its `finally` cleanup
 * could run. This self-heals a full volume on deploy (e.g. the frame piles that
 * made every subsequent render fail with "No space left on device").
 */
export async function reclaimOrphanRenderDisk(
  rendersDir: string,
): Promise<void> {
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(rendersDir, {
      withFileTypes: true,
    });
  } catch {
    return; // renders root not created yet — nothing to do
  }

  let removed = 0;
  for (const ent of projectDirs) {
    if (!ent.isDirectory()) continue;
    removed += await cleanupProjectWorkDirs(path.join(rendersDir, ent.name));
  }

  if (removed > 0) {
    logger.info({ removed }, "Reclaimed orphaned render work dirs on boot");
  }
}
