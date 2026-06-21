/**
 * Pure helpers for the website→video "which section" feature. Every section mode
 * (whole page, hero, a CSS element, an AI-picked region, a drag-selected
 * rectangle) reduces to a single CropRegion — 0–1 fractions of the captured
 * screenshot that the `website-showcase` composition zooms / scrolls into. Kept
 * dependency-free so it unit-tests trivially and can't drift from the composition.
 */

/** A region to FEATURE, as 0–1 fractions of the capture (x/y top-left, w/h size). */
export interface CropRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The capture viewport height — what a visitor sees "above the fold". */
export const HERO_PX = 800;
/** Floor for crop width/height — mirrors the composition so a stray 0 can't zoom to ∞. */
export const MIN_CROP_SIZE = 0.05;

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** The first screen of the page (full width, top viewport-height) as a crop. */
export function heroCrop(captureHeight: number): CropRegion {
  const h = captureHeight > 0 ? Math.min(1, HERO_PX / captureHeight) : 1;
  return { x: 0, y: 0, w: 1, h };
}

/**
 * An element's pixel bounding box (from Puppeteer) → a 0–1 crop of the capture.
 * `bbox` is in capture-pixel space (the page is rendered at `captureWidth` CSS
 * px). Values are clamped to the capture, and width/height are floored so a
 * zero-area element can't divide-by-zero downstream.
 */
export function bboxToCrop(
  bbox: { x: number; y: number; width: number; height: number },
  captureWidth: number,
  captureHeight: number,
): CropRegion {
  if (captureWidth <= 0 || captureHeight <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  return {
    x: clamp01(bbox.x / captureWidth),
    y: clamp01(bbox.y / captureHeight),
    w: Math.max(MIN_CROP_SIZE, clamp01(bbox.width / captureWidth)),
    h: Math.max(MIN_CROP_SIZE, clamp01(bbox.height / captureHeight)),
  };
}

/**
 * Format a 0–1 crop fraction as a NUMERIC-gate-safe string: clamp to [0,1] and
 * render WITHOUT exponential notation. A value in (0, 1e-6) would stringify as
 * "1e-7" (via `String`) and then fail `findUnsafeCompositionVar`'s numeric gate,
 * 400-ing the render; `toFixed(6)` keeps a plain decimal and we trim trailing
 * zeros to a clean "0" / "0.5" / "1".
 */
function cropToken(n: number): string {
  return clamp01(n).toFixed(6).replace(/\.?0+$/, "") || "0";
}

/**
 * A CropRegion → safe composition vars. Each value is a bare 0–1 number (digits +
 * a dot only, never exponential) so it's injection-proof even though it lands in
 * `parseFloat("{{capture.cropX}}")` literals (renderCompositionTemplate doesn't
 * escape quotes). Returns `{}` for no crop (whole-page render, unchanged).
 */
export function buildCropVars(crop: CropRegion | undefined): Record<string, string> {
  if (!crop) return {};
  return {
    "capture.cropX": cropToken(crop.x),
    "capture.cropY": cropToken(crop.y),
    "capture.cropW": cropToken(Math.max(MIN_CROP_SIZE, crop.w)),
    "capture.cropH": cropToken(Math.max(MIN_CROP_SIZE, crop.h)),
  };
}

// ───────────────────────────── AI section tour ──────────────────────────────
// The "describe your video" mode: the AI picks + orders sections, and we turn
// those picks (by index, into the candidate `sections`) into the composition's
// tour beats. These timing constants MUST stay in sync with website-showcase.html
// (the tour timeline derives the total length from them).
export const TOUR_INTRO_SECONDS = 3.3;
export const TOUR_OUTRO_SECONDS = 1.3;
export const TOUR_TRANSITION_SECONDS = 0.9;
export const TOUR_MAX_BEATS = 6;
const TOUR_MIN_HOLD = 1.5;
const TOUR_MAX_HOLD = 6;

/** One featured beat as the composition consumes it (crop fractions + timing). */
export interface TourBeat {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  seconds: number;
  caption: string | null;
}

/**
 * Turn the AI's ordered section picks + the candidate sections (each a label +
 * crop) into the composition's tour beats and the matching total duration.
 * Robust to a sloppy model: out-of-range / duplicate indexes are dropped, holds
 * are clamped, the beat count is capped, and captions are trimmed (they render
 * via textContent in the composition, so this is cosmetic, not a security gate).
 * Returns null when no valid beat survives — the caller then falls back to the
 * plain scroll.
 */
export function buildTour(
  picks: { index: number; seconds: number; caption?: string | null }[],
  sections: { crop: CropRegion }[],
): { beats: TourBeat[]; duration: number } | null {
  const seen = new Set<number>();
  const beats: TourBeat[] = [];
  for (const p of picks) {
    if (beats.length >= TOUR_MAX_BEATS) break;
    const i = Math.trunc(p.index);
    const section = sections[i];
    if (!section || seen.has(i)) continue;
    seen.add(i);
    const c = section.crop;
    const hold = Math.min(
      TOUR_MAX_HOLD,
      Math.max(TOUR_MIN_HOLD, Number.isFinite(p.seconds) ? p.seconds : 2.5),
    );
    const caption =
      typeof p.caption === "string" && p.caption.trim()
        ? p.caption.trim().replace(/\s+/g, " ").slice(0, 48)
        : null;
    beats.push({
      cropX: clamp01(c.x),
      cropY: clamp01(c.y),
      cropW: Math.max(MIN_CROP_SIZE, clamp01(c.w)),
      cropH: Math.max(MIN_CROP_SIZE, clamp01(c.h)),
      seconds: Math.round(hold * 100) / 100,
      caption,
    });
  }
  if (!beats.length) return null;
  const holds = beats.reduce((s, b) => s + b.seconds, 0);
  const transitions = (beats.length - 1) * TOUR_TRANSITION_SECONDS;
  const duration =
    Math.round(
      (TOUR_INTRO_SECONDS + holds + transitions + TOUR_OUTRO_SECONDS) * 10,
    ) / 10;
  return { beats, duration };
}
