import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  createRenderJob,
  executeRenderJob,
  type RenderConfig,
} from "@hyperframes/producer";
import type { Fps } from "@hyperframes/core";
import { eq } from "drizzle-orm";
import { db, brandKitTable, projectsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pick the first path that exists. esbuild bundles this module to dist/, so
 * `__dirname` differs between source layout (src/services) and the bundle
 * (dist/), and again in the Docker image (/app/dist). Probing candidates keeps
 * dev, prod and the container all working without per-env config.
 */
function firstExistingDir(candidates: string[], fallback: string): string {
  return candidates.find((p) => p && fs.existsSync(p)) ?? fallback;
}

/**
 * Directory where final rendered mp4 files are stored, keyed by project id.
 * Must be DETERMINISTIC — both the writer (startRender) and reader
 * (renderFileExists / GET :id/video) resolve it once at module load, so a
 * "first existing dir" probe would be a race (e.g. a stale ../../renders from
 * an earlier bug could win). The bundle always runs from dist/, so
 * `__dirname/../renders` is stable: `artifacts/api-server/renders` in dev and
 * `/app/renders` in the Docker image. Override with RENDERS_DIR (Railway
 * volume mount).
 */
export const RENDERS_DIR = process.env.RENDERS_DIR
  ? path.resolve(process.env.RENDERS_DIR)
  : path.resolve(__dirname, "../renders");

const COMPOSITIONS_DIR = firstExistingDir(
  [
    path.resolve(__dirname, "compositions"), // bundled next to dist (if copied)
    path.resolve(__dirname, "../compositions"), // prod Docker: /app/compositions
    path.resolve(__dirname, "../src/compositions"), // dev: dist/../src/compositions
    path.resolve(__dirname, "../../src/compositions"), // source layout
  ],
  path.resolve(__dirname, "../compositions"),
);

const COMPOSITION_MAP: Record<string, string> = {
  "product-launch": "product-launch.html",
  "brand-promo": "brand-promo.html",
  "social-teaser": "social-teaser.html",
  studio: "studio-default.html",
  ai: "social-teaser.html",
  bulk: "brand-promo.html",
};

const DEFAULT_COMPOSITION = "product-launch.html";

/** Default values for Studio placeholders when the user/brand leaves them blank. */
const STUDIO_FALLBACKS = {
  "brand.companyName": "Your Brand",
  "brand.initial": "S",
  "brand.primaryColor": "#6366f1",
  "brand.secondaryColor": "#1e293b",
  "brand.accentColor": "#f59e0b",
  "brand.fontFamily": "'Inter'",
  "brand.logoUrl": "",
  "user.headline": "Make something\nthey'll remember.",
  "user.bodyText":
    "Sorrel turns a template, your brand kit, and a few sentences into branded video — ready to ship.",
  "user.ctaText": "Try it free",
} as const;

/** Resolve the HTML composition filename for a given module slug. */
export function resolveEntryFile(module: string): string {
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Apply `{{key}}` substitutions to the composition source.
 *
 * - Brand values (companyName, primaryColor, …) are HTML-escaped.
 * - User text values (headline, bodyText, ctaText) are escaped and `\n`
 *   is rendered as `<br/>` for the headline / body fields.
 * - Unknown placeholders are left intact — keeps the HTML inspectable
 *   when debugging.
 */
export function renderCompositionTemplate(
  source: string,
  vars: Record<string, string>,
): string {
  return source.replace(
    /{{\s*([a-zA-Z0-9._-]+)\s*}}/g,
    (match, key: string) => {
      const value = vars[key];
      if (value === undefined) return match;
      const escaped = escapeHtml(value);
      return key.startsWith("user.")
        ? escaped.replaceAll("\n", "<br/>")
        : escaped;
    },
  );
}

interface BrandKitSnapshot {
  companyName: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  fontFamily: string | null;
  logoUrl: string | null;
}

function buildVarMap(
  brand: BrandKitSnapshot | null,
  compositionVars: Record<string, string> | null | undefined,
): Record<string, string> {
  const map: Record<string, string> = { ...STUDIO_FALLBACKS };
  if (brand) {
    if (brand.companyName) {
      map["brand.companyName"] = brand.companyName;
      map["brand.initial"] = brand.companyName.charAt(0).toUpperCase() || "S";
    }
    if (brand.primaryColor) map["brand.primaryColor"] = brand.primaryColor;
    if (brand.secondaryColor)
      map["brand.secondaryColor"] = brand.secondaryColor;
    if (brand.accentColor) map["brand.accentColor"] = brand.accentColor;
    if (brand.fontFamily) map["brand.fontFamily"] = brand.fontFamily;
    if (brand.logoUrl) map["brand.logoUrl"] = brand.logoUrl;
  }
  if (compositionVars) {
    for (const [k, v] of Object.entries(compositionVars)) {
      if (typeof v === "string" && v.length > 0) map[k] = v;
    }
  }
  return map;
}

async function loadBrandKit(userId: string): Promise<BrandKitSnapshot | null> {
  try {
    const [row] = await db
      .select()
      .from(brandKitTable)
      .where(eq(brandKitTable.userId, userId));
    if (!row) return null;
    return {
      companyName: row.companyName ?? null,
      primaryColor: row.primaryColor ?? null,
      secondaryColor: row.secondaryColor ?? null,
      accentColor: row.accentColor ?? null,
      fontFamily: row.fontFamily ?? null,
      logoUrl: row.logoUrl ?? null,
    };
  } catch (err) {
    logger.warn({ err, userId }, "Could not load brand kit");
    return null;
  }
}

/**
 * Materialize a per-render composition file with Studio variables already
 * substituted. Returns the directory + filename to feed Hyperframes.
 */
async function prepareCompositionFor(project: {
  id: number;
  userId: string;
  module: string;
  compositionVars: Record<string, string> | null;
}): Promise<{ dir: string; file: string }> {
  const baseEntryFile = resolveEntryFile(project.module);
  const source = fs.readFileSync(
    path.join(COMPOSITIONS_DIR, baseEntryFile),
    "utf-8",
  );

  const brand = await loadBrandKit(project.userId);
  const vars = buildVarMap(brand, project.compositionVars);
  const rendered = renderCompositionTemplate(source, vars);

  const dir = path.join(RENDERS_DIR, String(project.id));
  fs.mkdirSync(dir, { recursive: true });
  const file = "composition.html";
  fs.writeFileSync(path.join(dir, file), rendered, "utf-8");
  return { dir, file };
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
  const outputDir = path.join(RENDERS_DIR, String(projectId));
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "output.mp4");

  logger.info({ projectId, module, outputPath }, "Render job starting");

  await setProjectStatus(projectId, "rendering");

  try {
    // Re-read the project to pick up the userId + compositionVars at render time.
    const [project] = await db
      .select({
        id: projectsTable.id,
        userId: projectsTable.userId,
        module: projectsTable.module,
        compositionVars: projectsTable.compositionVars,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project)
      throw new Error(`Project ${projectId} disappeared mid-render`);

    const { dir, file } = await prepareCompositionFor(project);

    const config: RenderConfig = {
      fps: { num: 30, den: 1 } as Fps,
      quality: "draft",
      entryFile: file,
    };

    const job = createRenderJob(config);

    await executeRenderJob(job, dir, outputPath, (j, msg) => {
      logger.debug(
        { projectId, percent: Math.round(j.progress * 100), msg },
        "Render progress",
      );
    });

    const videoUrl = `/api/projects/${projectId}/video`;
    // Real clip length comes from the composition's window.__hf.duration,
    // surfaced on the job after render. Fall back to undefined (null in DB)
    // rather than a misleading constant.
    const renderedDuration =
      typeof job.duration === "number" && job.duration > 0
        ? Math.round(job.duration)
        : undefined;
    await setProjectStatus(projectId, "ready", {
      videoUrl,
      duration: renderedDuration,
    });
    logger.info(
      { projectId, videoUrl, duration: renderedDuration },
      "Render completed",
    );
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
