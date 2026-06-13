/**
 * Lambda render backend (M11) — dispatch + reconcile against the Hyperframes
 * distributed render fleet (`@hyperframes/aws-lambda`, Step Functions + Lambda).
 *
 * DEPENDENCY ISOLATION: `@hyperframes/aws-lambda` IS now a dependency (so this
 * file's types are the REAL ones), but it is still loaded only through a dynamic
 * `await import(...)` reached when the lambda backend is actually selected
 * (Pro + AWS env). That keeps its heavy native deps (@sparticuz/chromium,
 * ffmpeg-static, the AWS SDKs) out of the esbuild bundle (they're `external`)
 * and out of the dev/test/CI hot path. Importing THIS module is always safe.
 *
 * Two entry points:
 *   - `dispatchLambdaRender(...)`  — start a remote render: materialize the
 *     project dir (composition + sibling assets via `prepareCompositionFor`),
 *     run the safety guards (gif/max-frames/in-flight), build + validate a
 *     `SerializableDistributedRenderConfig`, call `renderToLambda`, and persist
 *     the execution ARN + flip the ledger row to `rendering`. Mirrors the inline
 *     path's status transitions on the PROJECT so the 3-second frontend poll
 *     keeps working.
 *   - `reconcileLambdaJob(row)`    — one-shot `getRenderProgress` for a single
 *     in-flight row: write progress/cost, and on a terminal state finalize
 *     (ready/failed) BOTH the ledger row and the project. Called by the poller.
 */
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  type RenderJobRow,
  type RenderSettings,
} from "@workspace/db";
import { logger } from "../logger";
import { prepareCompositionFor } from "../../services/renderService";
import { resolveDimensions } from "../../services/renderSettingsService";
import {
  getActiveLambdaJobs,
  markExternalId,
  markFailed,
  markProgressAndCost,
  markReady,
} from "../../services/renderJobsService";
import type { RenderProgress } from "@hyperframes/aws-lambda";
import type { SerializableDistributedRenderConfig } from "@hyperframes/producer/distributed";

/**
 * Hard ceiling on total frames a single Lambda render may produce. A runaway
 * composition (huge duration × 60fps × 4K) would fan out into a very expensive
 * Step Functions execution, so we refuse to dispatch past this. Overridable via
 * RENDER_MAX_FRAMES (default 18000 ≈ 5 min @ 60fps / 10 min @ 30fps).
 */
const RENDER_MAX_FRAMES =
  Number(process.env.RENDER_MAX_FRAMES ?? "18000") || 18000;

/**
 * Worst-case render duration (seconds) assumed when estimating frame count. The
 * true clip length isn't known until the composition runs, so we bound frames as
 * fps × this cap. Overridable via LAMBDA_MAX_RENDER_SECONDS (default 120).
 */
const LAMBDA_MAX_RENDER_SECONDS =
  Number(process.env.LAMBDA_MAX_RENDER_SECONDS ?? "120") || 120;

/**
 * Max concurrent in-flight Lambda renders this process will have outstanding.
 * Backpressure against accidental fan-out (and the per-run AWS cost). Overridable
 * via LAMBDA_MAX_IN_FLIGHT (default 4).
 */
const LAMBDA_MAX_IN_FLIGHT =
  Number(process.env.LAMBDA_MAX_IN_FLIGHT ?? "4") || 4;

/**
 * The package specifier, assembled at runtime so the bundler can't see it as a
 * static string literal. CRITICAL: `@hyperframes/aws-lambda` is NOT installed
 * (CLAUDE.md → M11). esbuild (the prod bundle) FAILS on an unresolvable
 * string-literal `import("@hyperframes/aws-lambda")`, so we hide the specifier
 * behind a variable — esbuild then leaves it as a runtime `import()` (a warning,
 * not an error) and Node resolves it only on a host where the operator installed
 * the package. The code path is never hit in dev/test/CI (lambda backend inert),
 * so the unresolved specifier is never imported there.
 */
const AWS_LAMBDA_PKG = ["@hyperframes", "aws-lambda"].join("/");

/** The dynamically-imported `@hyperframes/aws-lambda` module shape (ambient-typed). */
type AwsLambdaModule = typeof import("@hyperframes/aws-lambda");

/**
 * Load `@hyperframes/aws-lambda` at runtime. Centralizes the indirection so
 * there is exactly one `import()` call site, and it never receives a literal.
 */
async function loadAwsLambda(): Promise<AwsLambdaModule> {
  return import(AWS_LAMBDA_PKG) as Promise<AwsLambdaModule>;
}

/** Raised when a dispatch is refused by a safety guard (caller maps to a failure). */
export class LambdaDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LambdaDispatchError";
  }
}

export interface DispatchLambdaRenderInput {
  projectId: number;
  userId: string;
  module: string;
  /** Ledger row id (render_jobs) to advance. */
  renderJobId: string;
  /** Resolved, already Free/Pro-gated render settings. */
  settings: RenderSettings;
}

async function setProjectStatus(
  projectId: number,
  status: string,
  extra?: { videoUrl?: string; renderError?: string },
): Promise<void> {
  await db
    .update(projectsTable)
    .set({ status, ...extra })
    .where(eq(projectsTable.id, projectId));
}

/**
 * Conservative upper-bound frame count for a render: fps × the worst-case
 * duration cap. Used purely for the pre-dispatch guard, never for billing.
 */
function estimateMaxFrames(settings: RenderSettings): number {
  return settings.fps * LAMBDA_MAX_RENDER_SECONDS;
}

/**
 * Start a distributed render. Throws `LambdaDispatchError` if a guard rejects it;
 * the caller (renderQueue) treats that like any enqueue failure — releases the
 * project claim and marks the ledger row failed. On success the project is in
 * `rendering`, the ledger row carries the execution ARN, and the poller takes
 * over from here.
 */
export async function dispatchLambdaRender(
  input: DispatchLambdaRenderInput,
): Promise<void> {
  const { projectId, userId, module, renderJobId, settings } = input;

  // --- Guard 1: in-flight cap (backpressure against runaway fan-out/cost). ---
  const inFlight = await getActiveLambdaJobs();
  if (inFlight.length >= LAMBDA_MAX_IN_FLIGHT) {
    throw new LambdaDispatchError(
      `Too many in-flight Lambda renders (${inFlight.length}/${LAMBDA_MAX_IN_FLIGHT}) — try again shortly`,
    );
  }

  // --- Guard 2: gif is not a distributed format. The producer's own
  // validateDistributedRenderConfig (ALLOWED = mp4|mov|png-sequence|webm) would
  // reject it anyway, but a clear early message beats a wire-boundary throw. ---
  if (settings.format === "gif") {
    throw new LambdaDispatchError("GIF renders run locally, not on Lambda");
  }

  // --- Guard 3: max-frames ceiling (refuse pathologically large renders). ---
  const maxFrames = estimateMaxFrames(settings);
  if (maxFrames > RENDER_MAX_FRAMES) {
    throw new LambdaDispatchError(
      `Render exceeds the ${RENDER_MAX_FRAMES}-frame Lambda ceiling (estimated ${maxFrames})`,
    );
  }

  const bucketName = process.env.HYPERFRAMES_S3_BUCKET;
  const stateMachineArn = process.env.HYPERFRAMES_STATE_MACHINE_ARN;
  if (!bucketName || !stateMachineArn) {
    throw new LambdaDispatchError(
      "Lambda backend is not configured (HYPERFRAMES_S3_BUCKET + HYPERFRAMES_STATE_MACHINE_ARN required)",
    );
  }

  // Re-read the project so the materialized dir matches what the inline path
  // produces (buildCompositionHtml merges brand kit + vars). `userId` comes from
  // the (gated) ledger row, the authoritative owner.
  const [project] = await db
    .select({
      id: projectsTable.id,
      module: projectsTable.module,
      compositionVars: projectsTable.compositionVars,
      compositionHtml: projectsTable.compositionHtml,
      brandKitId: projectsTable.brandKitId,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  if (!project) {
    throw new LambdaDispatchError(`Project ${projectId} not found`);
  }

  // Materialize the per-project render dir (composition.html + sibling assets +
  // voiceover/bg-audio/transitions) EXACTLY like the inline path — renderToLambda
  // tars this dir + PUTs it to S3, so the remote render sees the same files. The
  // old html-string dispatch silently dropped those siblings.
  const { dir } = await prepareCompositionFor(
    {
      id: project.id,
      userId,
      module: project.module || module,
      compositionVars: project.compositionVars,
      compositionHtml: project.compositionHtml,
      brandKitId: project.brandKitId,
      renderSettings: settings,
    },
    {
      watermark: settings.watermark,
      backgroundAudio: settings.backgroundAudio,
      captions: settings.captions,
      voiceover: settings.voiceover,
      transitions: settings.transitions,
    },
  );

  // Build + client-side-validate the distributed config (integer fps, explicit
  // pixel dims, distributed-supported format). gif is already excluded above.
  const dims = resolveDimensions(settings.resolution);
  const config: SerializableDistributedRenderConfig = {
    fps: settings.fps,
    width: dims.width,
    height: dims.height,
    format: settings.format,
    quality: settings.quality,
  };

  // DYNAMIC import — only reached when the lambda backend is selected, so the
  // heavy native deps are never loaded by dev/test/CI.
  const { renderToLambda, validateDistributedRenderConfig } =
    await loadAwsLambda();
  validateDistributedRenderConfig(config);

  await setProjectStatus(projectId, "rendering");

  const handle = await renderToLambda({
    projectDir: dir,
    config,
    bucketName,
    stateMachineArn,
    region: process.env.AWS_REGION,
    executionName: `sorrel-${renderJobId}`,
  });

  // Persist the execution ARN, flip the row to rendering, AND (re)tag it as a
  // lambda job in one write. The endpoint opened the row with an inline/bullmq
  // backend before selection ran; correcting it here is what makes the poller
  // (backend=lambda, status=rendering) and the distributed quota pick it up.
  await markExternalId(renderJobId, handle.executionArn, {
    rendering: true,
    backend: "lambda",
  });

  logger.info(
    { projectId, renderJobId, executionArn: handle.executionArn },
    "Dispatched Lambda render",
  );
}

/** Normalized terminal classification of a remote execution status. */
type Terminal = "ready" | "failed" | "running";

/**
 * Classify the real `RenderStatus` union from `getRenderProgress`:
 *   SUCCEEDED → ready; FAILED|TIMED_OUT|ABORTED → failed;
 *   RUNNING|PENDING_REDRIVE (and any future addition) → running.
 * Defaults to "running" so an unrecognized status never prematurely fails a
 * render — the next poll re-checks.
 */
function classifyStatus(status: RenderProgress["status"]): Terminal {
  if (status === "SUCCEEDED") return "ready";
  if (status === "FAILED" || status === "TIMED_OUT" || status === "ABORTED") {
    return "failed";
  }
  return "running";
}

/** `overallProgress` is guaranteed [0,1] by the SDK → integer percent, clamped. */
function toPercent(overall: number): number {
  if (Number.isNaN(overall)) return 0;
  return Math.max(0, Math.min(100, Math.round(overall * 100)));
}

/** USD accrued → integer cents for the ledger's `costCents`. */
function usdToCents(usd: number | undefined): number | undefined {
  if (usd === undefined || !Number.isFinite(usd)) return undefined;
  return Math.round(usd * 100);
}

/**
 * Poll ONE in-flight Lambda render row once and reconcile the ledger + project.
 *
 * - Non-terminal → write the latest progress (and cost, if reported).
 * - SUCCEEDED    → mark the row `ready` (+ outputPath from the S3 URI, + cost)
 *                  and the project `ready` with its video URL.
 * - FAILED       → mark the row + project `failed` with the reported error.
 *
 * A row with no `externalId` (dispatch raced/never recorded one) is skipped: we
 * can't poll without it, and the stuck-render recovery will eventually reset it.
 * Never throws — a transient `getRenderProgress` error is logged and retried on
 * the next poll tick.
 */
export async function reconcileLambdaJob(row: RenderJobRow): Promise<void> {
  if (!row.externalId) {
    logger.warn(
      { renderJobId: row.id, projectId: row.projectId },
      "Lambda job has no executionArn yet — skipping reconcile",
    );
    return;
  }

  let progress: RenderProgress;
  try {
    const { getRenderProgress } = await loadAwsLambda();
    progress = await getRenderProgress({ executionArn: row.externalId });
  } catch (err) {
    logger.warn(
      { renderJobId: row.id, projectId: row.projectId, err },
      "getRenderProgress failed — will retry next tick",
    );
    return;
  }

  const terminal = classifyStatus(progress.status);
  const costCents = usdToCents(progress.costs?.accruedSoFarUsd);

  if (terminal === "running") {
    await markProgressAndCost(
      row.id,
      toPercent(progress.overallProgress),
      costCents,
    );
    return;
  }

  if (terminal === "ready") {
    const outputPath = progress.outputFile?.s3Uri;
    await markReady(row.id, {
      ...(outputPath ? { outputPath } : {}),
      ...(costCents !== undefined ? { costCents } : {}),
    });
    await setProjectStatus(row.projectId, "ready", {
      videoUrl: `/api/projects/${row.projectId}/video`,
    });
    logger.info(
      { renderJobId: row.id, projectId: row.projectId, outputPath },
      "Lambda render completed",
    );
    return;
  }

  // terminal === "failed" — RenderError[] are objects; format them readably.
  const renderError =
    progress.errors.length > 0
      ? progress.errors.map((e) => `${e.state}: ${e.error}`).join("; ")
      : "Lambda render failed";
  await markFailed(row.id, renderError);
  await setProjectStatus(row.projectId, "failed", { renderError });
  logger.error(
    { renderJobId: row.id, projectId: row.projectId, renderError },
    "Lambda render failed",
  );
}
