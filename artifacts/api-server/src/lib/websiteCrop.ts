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
 * A CropRegion → safe composition vars. Each is `String(a 0–1 number)` — digits +
 * a dot only — so it's injection-proof even though it lands in
 * `parseFloat("{{capture.cropX}}")` literals (renderCompositionTemplate doesn't
 * escape quotes). Returns `{}` for no crop (whole-page render, unchanged).
 */
export function buildCropVars(crop: CropRegion | undefined): Record<string, string> {
  if (!crop) return {};
  return {
    "capture.cropX": String(clamp01(crop.x)),
    "capture.cropY": String(clamp01(crop.y)),
    "capture.cropW": String(Math.max(MIN_CROP_SIZE, clamp01(crop.w))),
    "capture.cropH": String(Math.max(MIN_CROP_SIZE, clamp01(crop.h))),
  };
}
