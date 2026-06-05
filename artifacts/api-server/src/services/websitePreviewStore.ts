import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Short-lived, in-memory store for website→video CAPTURE PREVIEWS.
 *
 * The crop flow is two-step: `POST /website-to-video/preview` captures the full
 * page (SSRF-guarded) and returns the screenshot so the user can drag-select the
 * region to feature; `POST /website-to-video { previewId, crop }` then renders
 * that region. Between the two requests we keep the *server-captured* screenshot
 * here (keyed by an opaque id) instead of round-tripping a multi-MB data URI back
 * through the browser — the bytes that land in the composition stay server-owned.
 *
 * Single-instance only (a Map + temp files): a preview is created and consumed on
 * the same box within minutes, and losing previews on restart just means the user
 * re-captures. Entries are owner-scoped, single-use, and TTL-expired; the PNG
 * lives in a throwaway temp dir that's removed on consume or sweep.
 */
export interface PreviewEntry {
  screenshotPath: string;
  /** Directory to remove when the entry is consumed/expired. */
  dir: string;
  title: string;
  url: string;
  captureHeight: number;
  userId: string;
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes — plenty to pick a crop, bounds memory.
const store = new Map<string, PreviewEntry>();

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/** Drop every expired entry (and its temp dir). Called opportunistically. */
export function sweepExpiredPreviews(): void {
  const now = Date.now();
  for (const [id, e] of store) {
    if (e.expiresAt <= now) {
      store.delete(id);
      removeDir(e.dir);
    }
  }
}

/** Register a freshly-captured preview; returns its opaque id. */
export function savePreview(
  entry: Omit<PreviewEntry, "expiresAt">,
): string {
  sweepExpiredPreviews();
  const id = crypto.randomUUID();
  store.set(id, { ...entry, expiresAt: Date.now() + TTL_MS });
  return id;
}

/**
 * Fetch + remove a preview, enforcing ownership and TTL. Single-use: a second
 * consume of the same id returns null. The caller owns the temp dir afterwards
 * (read the screenshot, then call `disposePreview`). Returns null for a missing,
 * expired, or wrong-owner id — never leaking which it was.
 */
export function consumePreview(id: string, userId: string): PreviewEntry | null {
  const e = store.get(id);
  if (!e) return null;
  store.delete(id);
  if (e.userId !== userId || e.expiresAt <= Date.now()) {
    removeDir(e.dir);
    return null;
  }
  return e;
}

/** Remove a consumed preview's temp dir. */
export function disposePreview(entry: Pick<PreviewEntry, "dir">): void {
  removeDir(entry.dir);
}

/** Test seam: a throwaway temp dir for a capture. */
export function createPreviewDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-preview-"));
}
