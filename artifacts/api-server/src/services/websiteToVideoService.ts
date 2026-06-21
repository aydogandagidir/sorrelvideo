import fs from "node:fs";
import { db, projectsTable, DEFAULT_RENDER_SETTINGS } from "@workspace/db";
import {
  captureWebsite,
  WebsiteCaptureError,
  type PageSection,
  type CaptureMediaType,
  type ScrapedBrandSignals,
} from "./websiteCaptureService";
import { getProvider } from "@workspace/ai";
import { assertSafeCompositionVars } from "../lib/compositionVars";
import {
  buildCropVars,
  buildTour,
  heroCrop,
  type CropRegion,
} from "../lib/websiteCrop";
import {
  getBrandKit,
  getDefaultBrandKit,
  createBrandKit,
  isConfiguredBrandKit,
} from "./brandKitService";
import {
  refineBrandFromCapture,
  consumeAiUnitIfAvailable,
} from "./brandExtractionService";
import { logger } from "../lib/logger";
import {
  savePreview,
  consumePreview,
  disposePreview,
  createPreviewDir,
} from "./websitePreviewStore";

const SHOWCASE_MODULE = "website-showcase";
// Capture the WHOLE page (most landing pages are 4–8k px tall) so the showcase
// scrolls through all of it — the previous 2800px cap truncated tall sites
// (bluedev.dev), showing the page "incompletely". JPEG (below) keeps the inlined
// data URI bounded even at this height; object storage is the real long-term fix.
const SHOWCASE_MAX_CAPTURE_HEIGHT = 9000;
// JPEG, not PNG: a full-page screenshot as PNG would be multiple MB of base64 in
// the project's compositionVars jsonb (and re-read on every render/preview). JPEG
// q82 keeps a 1280×9000 capture well under ~1.5MB while staying crisp.
const CAPTURE_FORMAT: CaptureMediaType = "image/jpeg";
// The capture viewport width — the screenshot is this many px wide. The crop
// fractions the SPA sends back are relative to this × the captured height.
const CAPTURE_WIDTH = 1280;

// Duration bounds (seconds). It lands in the composition's `data-duration` and a
// `parseFloat("{{duration}}")` literal, and renderCompositionTemplate does NOT
// escape quotes — so only a clamped *number* is ever substituted. 3s floor keeps
// the fixed intro/outro from colliding; 60s ceiling bounds render cost.
const SHOWCASE_MIN_DURATION = 3;
const SHOWCASE_MAX_DURATION = 60;
const SHOWCASE_FALLBACK_DURATION = 9;

// Showcase timing (mirrors website-showcase.html): the screenshot is displayed
// 1300px wide and scrolls inside a 748px viewport; intro+outro are fixed. The
// AUTO duration sizes the scroll to a calm reading speed so the WHOLE page is
// shown without racing — the core of the "too short / shows it too briefly" fix.
const DISPLAY_WIDTH = 1300;
const DISPLAY_VIEWPORT_H = 748;
const INTRO_OUTRO_SECONDS = 3.3 + 1.3;
const SCROLL_PX_PER_SEC = 360; // calm, readable scroll pace
const AUTO_MAX_DURATION = 45; // don't auto-pick a 60s render; user can opt in

function clampDuration(raw: number): number {
  return Math.min(
    SHOWCASE_MAX_DURATION,
    Math.max(SHOWCASE_MIN_DURATION, Math.round(raw)),
  );
}

/**
 * Pick a calm default duration from the captured page height: enough seconds for
 * the page to scroll top→bottom at a readable pace, plus the fixed intro/outro.
 * A tall page therefore gets a longer (but capped) video instead of a 9s race.
 */
export function computeAutoDuration(captureHeight: number): number {
  const displayHeight = captureHeight * (DISPLAY_WIDTH / CAPTURE_WIDTH);
  const scrollPx = Math.max(0, displayHeight - DISPLAY_VIEWPORT_H);
  const total = INTRO_OUTRO_SECONDS + scrollPx / SCROLL_PX_PER_SEC;
  return Math.min(
    AUTO_MAX_DURATION,
    Math.max(SHOWCASE_MIN_DURATION, Math.round(total)),
  );
}

/** Explicit user duration wins (clamped); otherwise scale to the page height. */
function resolveDuration(
  raw: number | undefined,
  captureHeight: number,
): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return captureHeight > 0
      ? computeAutoDuration(captureHeight)
      : SHOWCASE_FALLBACK_DURATION;
  }
  return clampDuration(raw);
}

function dataUri(screenshotPath: string, mediaType: CaptureMediaType): string {
  return `data:${mediaType};base64,${fs.readFileSync(screenshotPath).toString("base64")}`;
}

/** A short, friendly brand-kit name derived from the captured URL. */
function brandKitNameFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").slice(0, 80);
  } catch {
    return "Captured brand";
  }
}

/**
 * Step 1 of the crop flow: capture the full page (SSRF-guarded) + brand signals
 * and stash it server-side so the SPA can show it, let the user drag-select a
 * region, then POST the region back. Returns the screenshot as a data URI + size.
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
      format: CAPTURE_FORMAT,
      // Always scrape brand signals so the crop flow can auto-create a kit too.
      extractBrand: true,
    });
    const image = dataUri(capture.screenshotPath, capture.mediaType);
    const previewId = savePreview({
      screenshotPath: capture.screenshotPath,
      dir,
      title: capture.title,
      url: capture.url,
      captureHeight: capture.height,
      mediaType: capture.mediaType,
      themeColor: capture.themeColor,
      brand: capture.brand,
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
  mediaType: CaptureMediaType;
  themeColor: string | null;
  cleanupDir: string;
  /** Set when a CSS `selector` matched during capture — the region to feature. */
  selectorCrop?: CropRegion;
  /** Set when `extractSections` — candidate sections for AI matching. */
  sections?: PageSection[];
  /** Scraped brand signals (preview path always has them; fresh path when asked). */
  brand?: ScrapedBrandSignals;
}

/**
 * Resolve the capture from a stored preview (the drag-crop flow) or a fresh URL
 * capture. `extractBrand` is threaded to a fresh capture so brand signals come
 * back with it; the preview already carries them from step 1.
 */
async function resolveCapture(
  userId: string,
  opts: {
    url?: string;
    previewId?: string;
    selector?: string;
    extractSections?: boolean;
    extractBrand?: boolean;
  },
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
      mediaType: preview.mediaType,
      themeColor: preview.themeColor,
      cleanupDir: preview.dir,
      brand: preview.brand,
    };
  }
  if (opts.url) {
    const dir = createPreviewDir();
    try {
      const capture = await captureWebsite(opts.url, dir, {
        maxHeight: SHOWCASE_MAX_CAPTURE_HEIGHT,
        format: CAPTURE_FORMAT,
        selector: opts.selector,
        extractSections: opts.extractSections,
        extractBrand: opts.extractBrand,
      });
      return {
        screenshotPath: capture.screenshotPath,
        height: capture.height,
        url: capture.url,
        title: capture.title,
        mediaType: capture.mediaType,
        themeColor: capture.themeColor,
        cleanupDir: dir,
        selectorCrop: capture.selectorCrop,
        sections: capture.sections,
        brand: capture.brand,
      };
    } catch (err) {
      disposePreview({ dir });
      throw err;
    }
  }
  throw new WebsiteCaptureError("A url or previewId is required.");
}

/**
 * Resolve which brand kit the showcase renders with, auto-creating one from the
 * captured site when the user has none yet (the fix for the "magenta Your Brand"
 * placeholder). Order: an explicit `brandKitId` (if owned) → the user's default
 * kit → a NEW kit extracted from the captured page. Returns the kit id (stamped
 * onto the project) or null when nothing could be resolved/scraped.
 */
async function resolveBrandKitId(
  userId: string,
  cap: ResolvedCapture,
  existing: { id: number } | null,
): Promise<number | null> {
  if (existing) return existing.id;
  if (!cap.brand) return null; // couldn't scrape signals → render uses fallbacks

  const allowAi = await consumeAiUnitIfAvailable(userId);
  const extracted = await refineBrandFromCapture(
    {
      url: cap.url,
      title: cap.title,
      themeColor: cap.themeColor,
      height: cap.height,
      screenshotPath: cap.screenshotPath,
      mediaType: cap.mediaType,
      brand: cap.brand,
    },
    { allowAi },
  );
  try {
    const created = await createBrandKit(userId, {
      name: brandKitNameFor(cap.url),
      companyName: extracted.companyName,
      primaryColor: extracted.primaryColor,
      secondaryColor: extracted.secondaryColor,
      accentColor: extracted.accentColor,
      fontFamily: extracted.fontFamily ?? undefined,
      logoUrl: extracted.logoUrl,
      sourceUrl: extracted.sourceUrl,
      isDefault: true,
      // Persist the narrative DNA too, so the auto-created kit is a full Brand DNA.
      tagline: extracted.tagline,
      description: extracted.description,
      valueProposition: extracted.valueProposition,
      targetAudience: extracted.targetAudience,
      industry: extracted.industry,
      keywords: extracted.keywords,
      personality: extracted.personality,
      imageStyle: extracted.imageStyle,
    });
    logger.info(
      { userId, brandKitId: created.id, url: cap.url, allowAi },
      "Auto-created brand kit from website",
    );
    return created.id;
  } catch (err) {
    // A malformed extracted value shouldn't fail the whole video — fall back to
    // no kit (render uses STUDIO_FALLBACKS) rather than 500.
    logger.warn({ err, userId, url: cap.url }, "Auto brand-kit create failed");
    return null;
  }
}

/**
 * The "describe your video" AI tour: capture's candidate sections + the user's
 * prompt → an ordered pan/zoom highlight reel (the composition's `capture.tour`).
 * Best-effort + quota-gated — with no provider key / no AI quota, or if the model
 * returns nothing usable, returns null and the caller renders the plain scroll.
 * Charges one AI unit only when it actually produces a tour.
 */
async function buildAiTour(
  userId: string,
  prompt: string,
  cap: ResolvedCapture,
): Promise<{ b64: string; duration: number } | null> {
  if (!cap.sections || cap.sections.length === 0) return null;
  const allowAi = await consumeAiUnitIfAvailable(userId);
  if (!allowAi) return null;
  try {
    const result = await getProvider().pickSections({
      prompt,
      title: cap.title,
      sections: cap.sections.map((s) => ({ label: s.label })),
    });
    const tour = buildTour(result.picks, cap.sections);
    if (!tour) return null;
    logger.info(
      {
        userId,
        url: cap.url,
        beats: tour.beats.length,
        duration: tour.duration,
      },
      "AI section tour built",
    );
    return {
      b64: Buffer.from(JSON.stringify(tour.beats), "utf-8").toString("base64"),
      duration: tour.duration,
    };
  } catch (err) {
    logger.warn(
      { err, userId, url: cap.url },
      "AI section tour failed; falling back to scroll",
    );
    return null;
  }
}

/**
 * website→video: build a draft `website-showcase` project from either a fresh URL
 * capture (`url`) or a previously-previewed capture (`previewId`, the crop flow).
 * The screenshot is embedded as a `capture.image` data URI; an optional `crop`
 * (0–1 fractions) features a region; `duration` sets the length (auto-scaled to
 * the page height when omitted). The project is stamped with a brand kit —
 * an existing/default one, or a new one auto-extracted from the site — so the
 * render is actually branded. Returns the project.
 *
 * Throws SsrfError (unsafe URL) or WebsiteCaptureError (couldn't load / preview
 * gone).
 */
export async function createWebsiteVideoProject(
  userId: string,
  opts: {
    url?: string;
    previewId?: string;
    duration?: number;
    brandKitId?: number;
    /** Force detecting a fresh brand kit from the site, ignoring the default. */
    autoBrand?: boolean;
    // "Which section" — at most one determines the crop; none = whole page:
    crop?: CropRegion; // an explicit drag-selected region (with previewId)
    selector?: string; // a CSS element ("by element")
    section?: "hero"; // a preset — the first screen
    /**
     * "Describe your video" — a natural-language brief. When set, the page's
     * sections are scraped and the AI picks + orders them into a curated pan/zoom
     * tour (the composition's `capture.tour`) instead of a flat scroll. Best-
     * effort: with no AI key / quota, or nothing usable, it falls back to scroll.
     */
    aiPrompt?: string;
  },
): Promise<typeof projectsTable.$inferSelect> {
  // Decide the brand kit BEFORE capture so we only pay to scrape brand signals
  // when we'll actually auto-create one. Reuse a kit only when it's pinned
  // explicitly, OR (not forced to auto-detect) the user has a CONFIGURED default
  // — an untouched/empty placeholder default doesn't count, so it can't reimpose
  // the generic "Your Brand" look on a site that has a real brand to detect.
  const pinned =
    opts.brandKitId != null ? await getBrandKit(userId, opts.brandKitId) : null;
  const defaultKit = pinned ? null : await getDefaultBrandKit(userId);
  const reuseKit =
    pinned ??
    (!opts.autoBrand && defaultKit && isConfiguredBrandKit(defaultKit)
      ? defaultKit
      : null);

  const cap = await resolveCapture(userId, {
    url: opts.url,
    previewId: opts.previewId,
    selector: opts.selector,
    // Scrape candidate sections only when the AI tour will use them.
    extractSections: !!opts.aiPrompt,
    extractBrand: !reuseKit, // only when we'll auto-create a kit
  });
  try {
    const brandKitId = await resolveBrandKitId(userId, cap, reuseKit);

    // "Describe your video": the AI picks + orders sections into a curated tour.
    // Best-effort — a null result falls through to the single-crop / scroll modes.
    const tour = opts.aiPrompt
      ? await buildAiTour(userId, opts.aiPrompt, cap)
      : null;

    // A tour drives its own length (intro + beats + outro); otherwise scale to
    // the page height (or an explicit user duration).
    const duration = tour
      ? tour.duration
      : resolveDuration(opts.duration, cap.height);

    // Resolve the single-crop region to feature (ignored when a tour won — the
    // tour owns the whole motion). Whole page → no crop.
    let crop = opts.crop;
    if (!tour) {
      if (!crop && opts.selector) crop = cap.selectorCrop;
      if (!crop && opts.section === "hero") crop = heroCrop(cap.height);
    }

    const compositionVars: Record<string, string> = {
      "capture.image": dataUri(cap.screenshotPath, cap.mediaType),
      "capture.height": String(cap.height),
      "capture.url": cap.url,
      "capture.title": cap.title,
      duration: String(duration),
      ...(tour ? { "capture.tour": tour.b64 } : buildCropVars(crop)),
    };

    // Defense in depth: route this server-built map through the same injection
    // gate the project write routes use (the image is a data URI, title/url are
    // captured text, numbers are clamped — so this never throws in practice).
    assertSafeCompositionVars(compositionVars);

    const [project] = await db
      .insert(projectsTable)
      .values({
        userId,
        name: cap.title || brandKitNameFor(cap.url),
        module: SHOWCASE_MODULE,
        compositionVars,
        brandKitId,
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
