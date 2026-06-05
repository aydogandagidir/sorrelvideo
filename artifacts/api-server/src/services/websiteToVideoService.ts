import fs from "node:fs";
import { db, projectsTable, DEFAULT_RENDER_SETTINGS } from "@workspace/db";
import { captureWebsite, WebsiteCaptureError } from "./websiteCaptureService";
import { assertSafeCompositionVars } from "../lib/compositionVars";
import {
  savePreview,
  consumePreview,
  disposePreview,
  createPreviewDir,
} from "./websitePreviewStore";

const SHOWCASE_MODULE = "website-showcase";
// Bound the embedded screenshot so the data URI stored in compositionVars (and
// inlined into the rendered composition) stays reasonable. ~2800px gives a hero
// + a couple of sections to scroll through.
const SHOWCASE_MAX_CAPTURE_HEIGHT = 2800;
// The capture viewport width — the screenshot is this many px wide. The crop
// fractions the SPA sends back are relative to this × the captured height.
const CAPTURE_WIDTH = 1280;

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

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** A drag-selected region to feature, as 0–1 fractions of the capture. */
export interface CropRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Crop fractions → safe composition vars. Each is `String(a 0–1 number)`, i.e.
 * digits + a dot only, so it's injection-proof even though it lands in
 * `parseFloat("{{capture.cropX}}")` literals (renderCompositionTemplate doesn't
 * escape quotes). The 5% width/height floors mirror the composition so a stray 0
 * can't divide-by-zero / zoom to infinity.
 */
function buildCropVars(crop: CropRegion | undefined): Record<string, string> {
  if (!crop) return {};
  return {
    "capture.cropX": String(clamp01(crop.x)),
    "capture.cropY": String(clamp01(crop.y)),
    "capture.cropW": String(Math.max(0.05, clamp01(crop.w))),
    "capture.cropH": String(Math.max(0.05, clamp01(crop.h))),
  };
}

/**
 * Step 1 of the crop flow: capture the full page (SSRF-guarded) and stash it
 * server-side so the SPA can show it, let the user drag-select a region, then
 * POST the region back. Returns the screenshot as a data URI + its pixel size.
 *
 * Throws SsrfError (unsafe URL) or WebsiteCaptureError (couldn't load the site).
 */
export async function captureWebsitePreview(
  userId: string,
  rawUrl: string,
): Promise<{ previewId: string; image: string; width: number; height: number }> {
  const dir = createPreviewDir();
  let saved = false;
  try {
    const capture = await captureWebsite(rawUrl, dir, {
      maxHeight: SHOWCASE_MAX_CAPTURE_HEIGHT,
    });
    const image =
      "data:image/png;base64," +
      fs.readFileSync(capture.screenshotPath).toString("base64");
    const previewId = savePreview({
      screenshotPath: capture.screenshotPath,
      dir,
      title: capture.title,
      url: capture.url,
      captureHeight: capture.height,
      userId,
    });
    saved = true;
    return { previewId, image, width: CAPTURE_WIDTH, height: capture.height };
  } finally {
    if (!saved) disposePreview({ dir }); // capture failed → don't leak the temp dir
  }
}

interface ResolvedCapture {
  screenshotPath: string;
  height: number;
  url: string;
  title: string;
  cleanupDir: string;
}

/** Resolve the capture from a stored preview (crop flow) or a fresh URL capture. */
async function resolveCapture(
  userId: string,
  opts: { url?: string; previewId?: string },
): Promise<ResolvedCapture> {
  if (opts.previewId) {
    const preview = consumePreview(opts.previewId, userId);
    if (!preview) {
      throw new WebsiteCaptureError(
        "That preview expired or wasn't found — capture the site again.",
      );
    }
    return {
      screenshotPath: preview.screenshotPath,
      height: preview.captureHeight,
      url: preview.url,
      title: preview.title,
      cleanupDir: preview.dir,
    };
  }
  if (opts.url) {
    const dir = createPreviewDir();
    try {
      const capture = await captureWebsite(opts.url, dir, {
        maxHeight: SHOWCASE_MAX_CAPTURE_HEIGHT,
      });
      return {
        screenshotPath: capture.screenshotPath,
        height: capture.height,
        url: capture.url,
        title: capture.title,
        cleanupDir: dir,
      };
    } catch (err) {
      disposePreview({ dir });
      throw err;
    }
  }
  throw new WebsiteCaptureError("A url or previewId is required.");
}

/**
 * website→video: build a draft `website-showcase` project from either a fresh URL
 * capture (`url`) or a previously-previewed capture (`previewId`, the crop flow).
 * The screenshot is embedded as a `capture.image` data URI (renderService
 * HTML-escapes the untrusted title/url); an optional `crop` (0–1 fractions)
 * features a region of the page; `duration` sets the length. Returns the project.
 *
 * Throws SsrfError (unsafe URL) or WebsiteCaptureError (couldn't load / preview
 * gone).
 */
export async function createWebsiteVideoProject(
  userId: string,
  opts: {
    url?: string;
    previewId?: string;
    crop?: CropRegion;
    duration?: number;
  },
): Promise<typeof projectsTable.$inferSelect> {
  const duration = clampDuration(opts.duration);
  const cap = await resolveCapture(userId, opts);
  try {
    const dataUri =
      "data:image/png;base64," +
      fs.readFileSync(cap.screenshotPath).toString("base64");

    const compositionVars: Record<string, string> = {
      "capture.image": dataUri,
      "capture.height": String(cap.height),
      "capture.url": cap.url,
      "capture.title": cap.title,
      duration: String(duration),
      ...buildCropVars(opts.crop),
    };

    // Defense in depth: route this server-built map through the same injection
    // gate the project write routes use. The values are a trusted image data URI,
    // the captured title/url, and clamped numbers — so this never throws in
    // practice; it guards against a future change letting attacker bytes in.
    assertSafeCompositionVars(compositionVars);

    let hostname = cap.url;
    try {
      hostname = new URL(cap.url).hostname;
    } catch {
      /* keep the full url as the fallback name */
    }

    const [project] = await db
      .insert(projectsTable)
      .values({
        userId,
        name: cap.title || hostname,
        module: SHOWCASE_MODULE,
        compositionVars,
        // The showcase is authored 1920×1080 — match the project so the render
        // isn't forced into the portrait default and letterboxed.
        renderSettings: { ...DEFAULT_RENDER_SETTINGS, resolution: "landscape" },
      })
      .returning();

    return project;
  } finally {
    fs.rmSync(cap.cleanupDir, { recursive: true, force: true });
  }
}
