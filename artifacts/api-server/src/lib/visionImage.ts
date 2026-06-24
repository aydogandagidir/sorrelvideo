import fs from "node:fs";
import sharp from "sharp";
import type { CaptureMediaType } from "../services/websiteCaptureService";
import { logger } from "./logger";

// Vision models reject images whose longest edge exceeds their hard limit
// (Claude ~8000px); a tall full-page website→video capture (up to 9000px) MUST
// be downscaled before it's sent. Cap the HEIGHT so the whole page still fits in
// a single image (a thin strip, but enough to judge structure / which bands have
// real content). The model downscales further internally — this just keeps us
// under the API ceiling and bounds tokens.
const MAX_VISION_HEIGHT = 1600;

export interface VisionImage {
  base64: string;
  mediaType: CaptureMediaType;
}

/**
 * Load a captured screenshot as a vision-ready image: a short capture passes
 * through untouched; a tall one is downscaled (via sharp) to MAX_VISION_HEIGHT
 * and re-encoded as JPEG so it stays under the vision API's dimension ceiling.
 * Best-effort — returns undefined on any failure (missing file, decode error) so
 * the caller falls back to a text-only decision instead of throwing.
 */
export async function loadVisionScreenshot(
  screenshotPath: string,
  mediaType: CaptureMediaType,
  height: number,
): Promise<VisionImage | undefined> {
  try {
    if (!fs.existsSync(screenshotPath)) return undefined;
    if (height <= MAX_VISION_HEIGHT) {
      return {
        base64: fs.readFileSync(screenshotPath).toString("base64"),
        mediaType,
      };
    }
    const buf = await sharp(screenshotPath)
      .resize({ height: MAX_VISION_HEIGHT, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    return { base64: buf.toString("base64"), mediaType: "image/jpeg" };
  } catch (err) {
    logger.warn({ err, screenshotPath }, "Vision screenshot downscale failed");
    return undefined;
  }
}
