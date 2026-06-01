/**
 * Ambient declaration for `@hyperframes/aws-lambda` — the package the
 * distributed (M11) render backend talks to.
 *
 * WHY THIS FILE EXISTS: `@hyperframes/aws-lambda` is deliberately NOT installed
 * (see CLAUDE.md → Future work / M11). Dev, test and CI need zero AWS and zero
 * extra dependency weight, so the api-server never imports it at module load.
 * `lambdaBackend.ts` / `lambdaProgressPoller.ts` reach it ONLY through a dynamic
 * `await import("@hyperframes/aws-lambda")`, guarded behind the lambda-backend
 * env. This file gives those call sites enough types to compile WITHOUT the
 * package on disk; the runtime import only happens once the operator has
 * deployed the CDK stack and installed the package on the render host.
 *
 * It is an ambient module declaration (`declare module`) under `src/`, so `tsc`
 * picks it up via the tsconfig `include` regardless of the `types` array. If the
 * package is ever actually installed, delete this file — the real types win.
 *
 * SHAPES are DEVELOPER-STATED (the API is unverified until the package is
 * adopted and the `0.6.6 → 0.6.65` alignment lands). Fields known to be
 * uncertain are flagged with `// NOTE`. The declarations are intentionally
 * permissive (optional result fields) so the reconcile/poll code is forced to
 * defensively handle missing data rather than trust a precise shape.
 */
declare module "@hyperframes/aws-lambda" {
  /** Options accepted by {@link renderToLambda}. */
  export interface RenderToLambdaOptions {
    /**
     * The fully-substituted composition HTML to render (produced by the
     * api-server's `buildCompositionHtml`). NOTE: the engine may instead expect
     * an S3 URI or an entry-file name — exact transport is unverified.
     */
    readonly html?: string;
    /**
     * Frame rate as an exact rational (mirrors the producer `RenderConfig.fps`,
     * which is `{ num, den }`, NOT an enum).
     */
    readonly fps?: { readonly num: number; readonly den: number };
    /** Output container format. */
    readonly format?: string;
    /** Render quality tier. */
    readonly quality?: string;
    /**
     * Output resolution preset name (mirrors core's `CanvasResolution` /
     * `CANVAS_DIMENSIONS` keys, e.g. "portrait", "landscape-4k").
     */
    readonly outputResolution?: string;
    /** True-alpha output (webm/mov/png-sequence). */
    readonly transparent?: boolean;
    /**
     * S3 bucket the engine streams chunks + the final artifact through. NOTE:
     * the construct OWNS its bucket, so the package may resolve this from env
     * (`HYPERFRAMES_S3_BUCKET`) rather than this option — passed defensively.
     */
    readonly bucket?: string;
    /** Caller correlation id (we thread the render_jobs ledger id through). */
    readonly correlationId?: string;
    /** Open-ended escape hatch — the verified option set is still unknown. */
    readonly [key: string]: unknown;
  }

  /**
   * Handle returned by {@link renderToLambda}. The Step Functions execution ARN
   * is the durable id the api-server polls and (on cancel) stops.
   */
  export interface RenderHandle {
    /** Step Functions execution ARN — persisted as `render_jobs.external_id`. */
    readonly executionArn: string;
  }

  /** Options accepted by {@link getRenderProgress}. */
  export interface GetRenderProgressOptions {
    /** The execution ARN returned by {@link renderToLambda}. */
    readonly executionArn: string;
    /** Open-ended escape hatch (e.g. region/bucket overrides). */
    readonly [key: string]: unknown;
  }

  /**
   * Progress snapshot for a running/finished render. All result fields beyond
   * `status` are optional on purpose (developer-stated, unverified) so callers
   * must null-check. NOTE: the exact `status` vocabulary is unverified — treat
   * anything that is not clearly terminal-success/terminal-failure as still
   * running.
   */
  export interface RenderProgress {
    /**
     * Execution status. NOTE: Step Functions states are typically
     * RUNNING | SUCCEEDED | FAILED | TIMED_OUT | ABORTED, but the package may
     * surface its own vocabulary — callers normalize defensively.
     */
    readonly status: string;
    /** Overall progress 0..1 (NOTE: could be 0..100 — callers clamp/scale). */
    readonly overallProgress?: number;
    /** Cost accounting; `totalCents` maps to `render_jobs.cost_cents`. */
    readonly costs?: { readonly totalCents?: number };
    /** The produced artifact location once terminal-success. */
    readonly outputFile?: { readonly s3Uri?: string };
    /** Failure messages once terminal-failure. */
    readonly errors?: readonly string[];
  }

  /**
   * Start a distributed render. Resolves once the execution has been STARTED
   * (not finished) with a handle the caller polls via {@link getRenderProgress}.
   */
  export function renderToLambda(
    opts: RenderToLambdaOptions,
  ): Promise<RenderHandle>;

  /** One-shot progress poll for a previously-started execution. */
  export function getRenderProgress(
    opts: GetRenderProgressOptions,
  ): Promise<RenderProgress>;
}
