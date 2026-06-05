import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, projectsTable, DEFAULT_RENDER_SETTINGS } from "@workspace/db";
import { captureWebsite } from "./websiteCaptureService";
import { assertSafeCompositionVars } from "../lib/compositionVars";

const SHOWCASE_MODULE = "website-showcase";
// Bound the embedded screenshot so the data URI stored in compositionVars (and
// inlined into the rendered composition) stays reasonable. ~2800px gives a hero
// + a couple of sections to scroll through.
const SHOWCASE_MAX_CAPTURE_HEIGHT = 2800;

// Video length is user-selectable. Coerce to a whole number of seconds in a sane
// range BEFORE it becomes a compositionVar: it lands in the composition's
// `data-duration` and a `parseFloat("{{duration}}")` JS literal, and
// renderCompositionTemplate does NOT escape quotes — so a clamped *number* is the
// only safe thing to substitute. 3s floor keeps the fixed intro/outro from
// colliding; 60s ceiling bounds render cost.
const SHOWCASE_DEFAULT_DURATION = 9;
const SHOWCASE_MIN_DURATION = 3;
const SHOWCASE_MAX_DURATION = 60;

function clampDuration(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return SHOWCASE_DEFAULT_DURATION;
  return Math.min(
    SHOWCASE_MAX_DURATION,
    Math.max(SHOWCASE_MIN_DURATION, Math.round(raw)),
  );
}

/**
 * website→video: screenshot a user-supplied URL (SSRF-guarded by captureWebsite)
 * and create a draft project from the branded `website-showcase` composition. The
 * screenshot is embedded as a `capture.image` data URI in compositionVars (read
 * by renderService at render time, which HTML-escapes the untrusted title/url),
 * so no asset file has to be threaded through the render dir. Returns the created
 * project so the caller can return it / the SPA can navigate to it.
 *
 * Throws SsrfError (unsafe URL) or WebsiteCaptureError (couldn't load the site).
 */
export async function createWebsiteVideoProject(
  userId: string,
  rawUrl: string,
  opts?: { duration?: number },
): Promise<typeof projectsTable.$inferSelect> {
  const duration = clampDuration(opts?.duration);
  // Capture into a throwaway temp dir — the PNG is embedded as a data URI, never kept.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-capture-"));
  try {
    const capture = await captureWebsite(rawUrl, tmpDir, {
      maxHeight: SHOWCASE_MAX_CAPTURE_HEIGHT,
    });
    const dataUri =
      "data:image/png;base64," +
      fs.readFileSync(capture.screenshotPath).toString("base64");

    const compositionVars: Record<string, string> = {
      "capture.image": dataUri,
      "capture.height": String(capture.height),
      "capture.url": capture.url,
      "capture.title": capture.title,
      // Safe: a clamped integer stringifies to digits only — no quote / JS-break
      // risk even though it lands in `data-duration` + a parseFloat("…") literal.
      duration: String(duration),
    };

    // Defense in depth: route this server-built map through the same injection
    // gate the project write routes use. The capture is trusted (an image/png
    // data URI), so this never throws in practice — it guards against a future
    // change that lets attacker-controlled bytes into an `<img src>` key.
    assertSafeCompositionVars(compositionVars);

    let hostname = capture.url;
    try {
      hostname = new URL(capture.url).hostname;
    } catch {
      /* keep the full url as the fallback name */
    }

    const [project] = await db
      .insert(projectsTable)
      .values({
        userId,
        name: capture.title || hostname,
        module: SHOWCASE_MODULE,
        compositionVars,
        // The showcase is authored 1920×1080 — match the project so the render
        // isn't forced into the portrait default and letterboxed.
        renderSettings: { ...DEFAULT_RENDER_SETTINGS, resolution: "landscape" },
      })
      .returning();

    return project;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
