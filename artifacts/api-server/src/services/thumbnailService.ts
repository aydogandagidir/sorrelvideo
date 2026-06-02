/**
 * Thumbnail generation — best-effort poster frame for a rendered project.
 *
 * Called after a successful render to drop a `thumb.png` next to the output
 * artifact. The render must NEVER fail because a thumbnail couldn't be made, so
 * every path here is defensive: failures are logged and surface as a `null`
 * return, not a throw. The video route serves the file at
 * `GET /api/projects/:id/thumbnail` when present.
 *
 * - Video formats (mp4/webm/mov): grab the first frame with FFmpeg
 *   (`-frames:v 1`). FFmpeg is on PATH (it's the render pipeline's encoder).
 * - png-sequence: `outputPath` is a DIRECTORY of `frame_*.png`; copy the first
 *   frame straight to `thumb.png` (no decode needed).
 */
import path from "path";
import fs from "fs";
import { spawn } from "node:child_process";
import type { RenderFormat } from "@workspace/db";
import { logger } from "../lib/logger";

/** Filename of the generated poster frame, written into the render dir. */
export const THUMBNAIL_FILENAME = "thumb.png";

/** Run ffmpeg to extract a single poster frame; resolves true on exit code 0. */
function extractFrameWithFfmpeg(
  videoPath: string,
  thumbPath: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", videoPath, "-frames:v", "1", thumbPath],
      { stdio: "ignore" },
    );
    child.on("error", (err) => {
      logger.warn({ err, videoPath }, "ffmpeg thumbnail spawn failed");
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

/** First `frame_*.png` in a png-sequence directory, or null when none exist. */
function firstSequenceFrame(dir: string): string | null {
  try {
    const frames = fs
      .readdirSync(dir)
      .filter((f) => /^frame_\d+\.png$/i.test(f))
      .sort();
    return frames.length > 0 ? path.join(dir, frames[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Generate `<renderDir>/thumb.png` from a finished render. Best-effort: returns
 * the thumbnail path on success, or `null` if it could not be produced (the
 * caller treats that as "no thumbnail" and never fails the render).
 */
export async function generateThumbnail(
  projectId: number,
  renderDir: string,
  outputPath: string,
  format: RenderFormat,
): Promise<string | null> {
  const thumbPath = path.join(renderDir, THUMBNAIL_FILENAME);
  try {
    if (format === "png-sequence") {
      const frame = firstSequenceFrame(outputPath);
      if (!frame) {
        logger.warn(
          { projectId, outputPath },
          "No PNG-sequence frame found for thumbnail",
        );
        return null;
      }
      fs.copyFileSync(frame, thumbPath);
    } else {
      const ok = await extractFrameWithFfmpeg(outputPath, thumbPath);
      if (!ok) {
        logger.warn(
          { projectId, outputPath, format },
          "ffmpeg could not extract a thumbnail frame",
        );
        return null;
      }
    }

    if (!fs.existsSync(thumbPath)) {
      logger.warn(
        { projectId, thumbPath },
        "Thumbnail file missing after generation",
      );
      return null;
    }
    logger.info({ projectId, thumbPath }, "Thumbnail generated");
    return thumbPath;
  } catch (err) {
    logger.warn({ projectId, err }, "Thumbnail generation failed");
    return null;
  }
}

/** Full filesystem path to a project's thumbnail (may not exist). */
export function getThumbnailPath(
  rendersDir: string,
  projectId: number,
): string {
  return path.join(rendersDir, String(projectId), THUMBNAIL_FILENAME);
}
