import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRenderJob, executeRenderJob, type RenderConfig } from "@hyperframes/producer";
import type { Fps } from "@hyperframes/core";
import { db, projectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Directory where final rendered mp4 files are stored, keyed by project id. */
export const RENDERS_DIR = path.resolve(__dirname, "../../renders");

const COMPOSITION_MAP: Record<string, string> = {
  "product-launch": "product-launch.html",
  "brand-promo": "brand-promo.html",
  "social-teaser": "social-teaser.html",
  studio: "product-launch.html",
  ai: "social-teaser.html",
  bulk: "brand-promo.html",
};

const DEFAULT_COMPOSITION = "product-launch.html";

/** Resolve the HTML composition filename for a given module slug. */
function resolveEntryFile(module: string): string {
  return COMPOSITION_MAP[module] ?? DEFAULT_COMPOSITION;
}

async function setProjectStatus(
  projectId: number,
  status: string,
  extra?: { videoUrl?: string; duration?: number; renderError?: string },
) {
  await db
    .update(projectsTable)
    .set({ status, ...extra })
    .where(eq(projectsTable.id, projectId));
}

/**
 * Kick off a Hyperframes render job in the background.
 * Sets project status: draft/failed → rendering → ready/failed.
 */
export async function startRender(
  projectId: number,
  module: string,
  _templateId?: number | null,
): Promise<void> {
  const compositionsDir = path.resolve(__dirname, "../compositions");
  const entryFile = resolveEntryFile(module);

  const outputDir = path.join(RENDERS_DIR, String(projectId));
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "output.mp4");

  logger.info({ projectId, entryFile, outputPath }, "Render job starting");

  await setProjectStatus(projectId, "rendering");

  try {
    const config: RenderConfig = {
      fps: { num: 30, den: 1 } as Fps,
      quality: "draft",
      entryFile,
    };

    const job = createRenderJob(config);

    await executeRenderJob(job, compositionsDir, outputPath, (j, msg) => {
      logger.debug({ projectId, percent: Math.round(j.progress * 100), msg }, "Render progress");
    });

    const videoUrl = `/api/projects/${projectId}/video`;
    await setProjectStatus(projectId, "ready", { videoUrl, duration: 10 });
    logger.info({ projectId, videoUrl }, "Render completed");
  } catch (err) {
    const renderError = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, err }, "Render failed");
    await setProjectStatus(projectId, "failed", { renderError });
  }
}

/** Check if a rendered video file exists for the given project. */
export function renderFileExists(projectId: number): boolean {
  const outputPath = path.join(RENDERS_DIR, String(projectId), "output.mp4");
  return fs.existsSync(outputPath);
}

/** Full filesystem path to the rendered mp4. */
export function getRenderFilePath(projectId: number): string {
  return path.join(RENDERS_DIR, String(projectId), "output.mp4");
}
