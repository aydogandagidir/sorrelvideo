import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  createRenderJob,
  executeRenderJob,
  RenderCancelledError,
} from "@hyperframes/producer";
import { eq } from "drizzle-orm";
import { db, brandKitTable, projectsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { resolveSettings, toEngineConfig } from "./renderSettingsService";
import {
  markCancelled,
  markFailed,
  markProgress,
  markReady,
  markRendering,
} from "./renderJobsService";

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

/**
 * Escape only the markup-dangerous characters. Safe for HTML text content and
 * for values injected into `<style>`/CSS: it prevents `</style>`/`</script>`
 * breakout and HTML injection while leaving quotes intact, so CSS like
 * `font-family: 'Inter'` survives instead of becoming `font-family: &#39;Inter&#39;`.
 */
function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Full HTML escaping incl. quotes — for user free-text rendered as HTML content. */
function escapeHtml(value: string): string {
  return escapeMarkup(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Apply `{{key}}` substitutions to the composition source.
 *
 * - `user.*` values (headline, bodyText, ctaText) are free text rendered into
 *   HTML content: fully escaped (incl. quotes) and `\n` becomes `<br/>`.
 * - `brand.*` values land in CSS (font-family, colors) or HTML text. They are
 *   markup-escaped only (`& < >`) so CSS quotes survive — escaping `'` to
 *   `&#39;` here previously broke `font-family: 'Inter'` at render time.
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
      if (key.startsWith("user.")) {
        return escapeHtml(value).replaceAll("\n", "<br/>");
      }
      return escapeMarkup(value);
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
 * Execute a Hyperframes render to completion (the "work" half of the pipeline).
 * Called either inline (no Redis) or by the BullMQ worker (see renderQueue.ts).
 * Sets project status: → rendering → ready/failed.
 */
export async function executeRender(
  projectId: number,
  module: string,
  _templateId?: number | null,
  renderJobId?: string,
): Promise<void> {
  const outputDir = path.join(RENDERS_DIR, String(projectId));
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "output.mp4");

  logger.info(
    { projectId, module, outputPath, renderJobId },
    "Render job starting",
  );

  await setProjectStatus(projectId, "rendering");
  if (renderJobId) await markRendering(renderJobId);

  try {
    // Re-read the project to pick up the userId + compositionVars +
    // renderSettings at render time.
    const [project] = await db
      .select({
        id: projectsTable.id,
        userId: projectsTable.userId,
        module: projectsTable.module,
        compositionVars: projectsTable.compositionVars,
        renderSettings: projectsTable.renderSettings,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project)
      throw new Error(`Project ${projectId} disappeared mid-render`);

    const { dir, file } = await prepareCompositionFor(project);

    // Resolve the per-project settings (null → DEFAULT_RENDER_SETTINGS) and map
    // them to the engine's RenderConfig. The Free/Pro gate already ran at the
    // route layer; here we just honor the persisted, validated config.
    const config = toEngineConfig(resolveSettings(project.renderSettings), file);

    const job = createRenderJob(config);

    await executeRenderJob(job, dir, outputPath, (j, msg) => {
      logger.debug(
        { projectId, percent: Math.round(j.progress * 100), msg },
        "Render progress",
      );
      if (renderJobId) {
        void markProgress(renderJobId, Math.round(j.progress * 100)).catch(
          (err) =>
            logger.warn(
              { renderJobId, err },
              "Could not persist render progress",
            ),
        );
      }
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
    if (renderJobId)
      await markReady(renderJobId, { duration: renderedDuration, outputPath });
    logger.info(
      { projectId, videoUrl, duration: renderedDuration, renderJobId },
      "Render completed",
    );
  } catch (err) {
    // A cancellation is an expected outcome, not a failure: roll the project
    // back to a draft so it can be re-rendered, and mark the job cancelled
    // without writing a renderError the UI would surface as a problem.
    if (err instanceof RenderCancelledError) {
      logger.info({ projectId, renderJobId }, "Render cancelled");
      await setProjectStatus(projectId, "draft");
      if (renderJobId) await markCancelled(renderJobId);
      return;
    }
    const renderError = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, err }, "Render failed");
    await setProjectStatus(projectId, "failed", { renderError });
    if (renderJobId) await markFailed(renderJobId, renderError);
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
