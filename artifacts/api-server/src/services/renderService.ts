import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  createRenderJob,
  executeRenderJob,
  RenderCancelledError,
} from "@hyperframes/producer";
import { eq } from "drizzle-orm";
import {
  db,
  brandKitTable,
  projectsTable,
  type RenderFormat,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { resolveSettings, toEngineConfig } from "./renderSettingsService";
import {
  getLatestJobForProject,
  markCancelled,
  markFailed,
  markProgress,
  markReady,
  markRendering,
} from "./renderJobsService";
import { generateThumbnail } from "./thumbnailService";

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

/** Output filename per video container format (no leading directory). */
const OUTPUT_FILENAME: Record<Exclude<RenderFormat, "png-sequence">, string> = {
  mp4: "output.mp4",
  webm: "output.webm",
  mov: "output.mov",
};

/**
 * Resolve the artifact path the producer should write to, given the render
 * directory and the chosen format.
 *
 * - Video formats (mp4/webm/mov) → a FILE: `<dir>/output.<ext>`. `mp4` stays
 *   `<dir>/output.mp4` exactly as before this function existed, so a
 *   default-settings render (format → mp4) is byte-for-byte unchanged.
 * - `png-sequence` → a DIRECTORY the producer fills with `frame_*.png`:
 *   `<dir>/frames`. The producer treats `outputPath` as a directory for this
 *   format (and creates it if absent).
 */
export function outputPathFor(dir: string, format: RenderFormat): string {
  if (format === "png-sequence") return path.join(dir, "frames");
  return path.join(dir, OUTPUT_FILENAME[format]);
}

async function setProjectStatus(
  projectId: number,
  status: string,
  extra?: {
    videoUrl?: string;
    duration?: number;
    renderError?: string;
    thumbnailUrl?: string;
  },
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
 * Build the fully-substituted composition HTML for a project as a STRING,
 * WITHOUT touching disk. This is the single source of the merge — it loads the
 * brand kit, merges it with the project's `compositionVars` over
 * `STUDIO_FALLBACKS` (via `buildVarMap`), reads the composition file for the
 * project's module, and runs `renderCompositionTemplate`.
 *
 * Both the render pipeline (`prepareCompositionFor`, which persists the result)
 * and the live preview route (GET :id/composition, which serves it inline)
 * consume this, so a rendered mp4 and a previewed page are guaranteed identical
 * for the same vars.
 *
 * STUDIO OVERRIDE: when `project.compositionHtml` is a non-empty string (the
 * Studio persisted a fully-authored document via routes/studio.ts), that HTML
 * is returned VERBATIM — the template+vars merge is skipped, because the saved
 * document is already final. Null/empty → the legacy merge, so a project that
 * never went through Studio (and the smoke-test default with compositionHtml
 * null) renders byte-for-byte as before this branch existed.
 */
export async function buildCompositionHtml(project: {
  id: number;
  userId: string;
  module: string;
  compositionVars: Record<string, string> | null;
  compositionHtml?: string | null;
}): Promise<string> {
  if (
    typeof project.compositionHtml === "string" &&
    project.compositionHtml.length > 0
  ) {
    return project.compositionHtml;
  }

  const baseEntryFile = resolveEntryFile(project.module);
  const source = fs.readFileSync(
    path.join(COMPOSITIONS_DIR, baseEntryFile),
    "utf-8",
  );

  const brand = await loadBrandKit(project.userId);
  const vars = buildVarMap(brand, project.compositionVars);
  return renderCompositionTemplate(source, vars);
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
  compositionHtml?: string | null;
}): Promise<{ dir: string; file: string }> {
  const rendered = await buildCompositionHtml(project);

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

  logger.info(
    { projectId, module, outputDir, renderJobId },
    "Render job starting",
  );

  await setProjectStatus(projectId, "rendering");
  if (renderJobId) await markRendering(renderJobId);

  try {
    // Re-read the project to pick up the userId + compositionVars +
    // compositionHtml + renderSettings at render time. compositionHtml, when a
    // Studio document is saved, takes precedence over the template+vars merge
    // (see buildCompositionHtml); null keeps the legacy default path.
    const [project] = await db
      .select({
        id: projectsTable.id,
        userId: projectsTable.userId,
        module: projectsTable.module,
        compositionVars: projectsTable.compositionVars,
        compositionHtml: projectsTable.compositionHtml,
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
    const settings = resolveSettings(project.renderSettings);
    const format = settings.format;
    // Format drives the artifact path: mp4 → output.mp4 (unchanged default),
    // webm/mov → output.<ext> (file), png-sequence → frames/ (directory).
    const outputPath = outputPathFor(outputDir, format);
    const config = toEngineConfig(settings, file);

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

    // Best-effort poster frame. A thumbnail failure must NEVER fail the render,
    // so swallow everything here and only set thumbnailUrl when one was written.
    let thumbnailUrl: string | undefined;
    try {
      const thumb = await generateThumbnail(projectId, dir, outputPath, format);
      if (thumb) thumbnailUrl = `/api/projects/${projectId}/thumbnail`;
    } catch (thumbErr) {
      logger.warn(
        { projectId, err: thumbErr },
        "Thumbnail generation threw; continuing without one",
      );
    }

    await setProjectStatus(projectId, "ready", {
      videoUrl,
      duration: renderedDuration,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    });
    // Persist the real artifact path on the ledger row. The format was stamped
    // at job creation (createRenderJob), so the row now carries both.
    if (renderJobId)
      await markReady(renderJobId, { duration: renderedDuration, outputPath });
    logger.info(
      { projectId, videoUrl, format, duration: renderedDuration, renderJobId },
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

/**
 * The default (legacy) mp4 path for a project. Used as the back-compat fallback
 * when there's no ready render-job row to read an exact `outputPath` from.
 */
function defaultMp4Path(projectId: number): string {
  return path.join(RENDERS_DIR, String(projectId), "output.mp4");
}

/**
 * Check if a rendered video file exists for the given project. SYNC fallback
 * kept for back-compat: it only knows the legacy `output.mp4` location. New
 * callers that may serve webm/mov/png-sequence should use the async variant,
 * which resolves the real artifact path from the latest ready render job.
 */
export function renderFileExists(projectId: number): boolean {
  return fs.existsSync(defaultMp4Path(projectId));
}

/** Full filesystem path to the rendered mp4 (SYNC, legacy `output.mp4`). */
export function getRenderFilePath(projectId: number): string {
  return defaultMp4Path(projectId);
}

/**
 * The rendered artifact for a project, resolved format-aware. Prefers the
 * latest READY render-job row's persisted `outputPath` + `format`; falls back
 * to the legacy `output.mp4` (format `"mp4"`) when no such row exists, so old
 * projects rendered before the ledger carried an `outputPath` still resolve.
 *
 * `format` lets the route pick the right `Content-Type` and detect the
 * `png-sequence` case (a directory, not a streamable file).
 */
export async function getRenderArtifact(
  projectId: number,
): Promise<{ path: string; format: RenderFormat }> {
  const job = await getLatestJobForProject(projectId);
  if (job && job.status === "ready" && job.outputPath) {
    const format = resolveSettings(job.config ?? null).format;
    return { path: job.outputPath, format };
  }
  return { path: defaultMp4Path(projectId), format: "mp4" };
}

/**
 * Async, format-aware existence check used by the video route. A `png-sequence`
 * render's `outputPath` is a DIRECTORY; for every other format it's a file.
 * Falls back to the legacy `output.mp4` probe when there's no ready job.
 */
export async function renderFileExistsAsync(
  projectId: number,
): Promise<boolean> {
  const { path: artifactPath } = await getRenderArtifact(projectId);
  return fs.existsSync(artifactPath);
}

/** Async, format-aware artifact path (see `getRenderArtifact`). Back-compat async twin of `getRenderFilePath`. */
export async function getRenderFilePathAsync(
  projectId: number,
): Promise<string> {
  const { path: artifactPath } = await getRenderArtifact(projectId);
  return artifactPath;
}
