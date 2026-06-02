/**
 * Render-backend selection (M11).
 *
 * Sorrel can run a render in one of three places:
 *   - `inline`  — in-process, fire-and-forget (the original behavior; no infra).
 *   - `bullmq`  — a durable BullMQ queue + in-process worker (needs REDIS_URL).
 *   - `lambda`  — a distributed Hyperframes render fleet on AWS (Step Functions
 *                 + Lambda), polled for progress (needs the AWS env + a Pro plan).
 *
 * This module is the SINGLE place that decides which one a given render uses.
 * It is intentionally pure + dependency-free (just `process.env` + the logger)
 * so it unit-tests trivially and can never throw: an unavailable or misconfigured
 * preference always DEGRADES to the next-best backend, logging a warning, rather
 * than failing a render. The selection rules:
 *
 *   RENDER_BACKEND env  → "inline" | "bullmq" | "lambda" | "auto"  (default "inline")
 *
 *   - "inline"  → always inline.
 *   - "bullmq"  → bullmq if REDIS_URL is set, else degrade to inline.
 *   - "lambda"  → lambda ONLY when the plan is "pro" AND the AWS env is present
 *                 (AWS_REGION + HYPERFRAMES_S3_BUCKET). Otherwise degrade:
 *                 bullmq if REDIS_URL, else inline.
 *   - "auto"    → prefer the richest available backend FOR THE PLAN: lambda for
 *                 pro when AWS env is present, else bullmq when REDIS_URL is set,
 *                 else inline. Free users never get lambda under "auto".
 *
 * Hard invariants (covered by renderBackend.test.ts):
 *   - lambda is NEVER selected for a free plan.
 *   - lambda is NEVER selected without BOTH AWS_REGION and HYPERFRAMES_S3_BUCKET.
 */
import { logger } from "./logger";

export type RenderBackend = "inline" | "bullmq" | "lambda";

/** The user-facing knob, post-validation. `auto` is resolved away by selection. */
type BackendPreference = RenderBackend | "auto";

/** True when a Redis URL is configured (bullmq is then available). */
function redisAvailable(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/**
 * True when the AWS env needed to dispatch a Lambda render is present. We require
 * BOTH a region and the render bucket — the `@hyperframes/aws-lambda` SDK streams
 * everything through that S3 bucket, so without it a dispatch is dead on arrival.
 * (Access keys are read by the AWS SDK itself; their absence surfaces at call
 * time, not here — but region + bucket are the two we can cheaply pre-check.)
 */
export function lambdaEnvReady(): boolean {
  return Boolean(process.env.AWS_REGION && process.env.HYPERFRAMES_S3_BUCKET);
}

/** Read + validate RENDER_BACKEND, defaulting to "inline" on unset/garbage. */
function readPreference(): BackendPreference {
  const raw = (process.env.RENDER_BACKEND ?? "inline").trim().toLowerCase();
  if (
    raw === "inline" ||
    raw === "bullmq" ||
    raw === "lambda" ||
    raw === "auto"
  ) {
    return raw;
  }
  logger.warn(
    { RENDER_BACKEND: process.env.RENDER_BACKEND },
    'Unknown RENDER_BACKEND value — falling back to "inline"',
  );
  return "inline";
}

/** The best NON-lambda backend currently available (bullmq if Redis, else inline). */
function bestNonLambda(): RenderBackend {
  return redisAvailable() ? "bullmq" : "inline";
}

/**
 * Decide which backend a render for `plan` should use. Never throws; logs a
 * warning whenever a requested backend is unavailable and it degrades.
 */
export function selectBackend(plan: "free" | "pro"): RenderBackend {
  const preference = readPreference();

  // Lambda is gated on BOTH a Pro plan AND the AWS env. Compute eligibility once.
  const lambdaEligible = plan === "pro" && lambdaEnvReady();

  switch (preference) {
    case "inline":
      return "inline";

    case "bullmq":
      if (redisAvailable()) return "bullmq";
      logger.warn(
        "RENDER_BACKEND=bullmq but REDIS_URL is unset — degrading to inline",
      );
      return "inline";

    case "lambda": {
      if (lambdaEligible) return "lambda";
      const fallback = bestNonLambda();
      logger.warn(
        {
          plan,
          lambdaEnvReady: lambdaEnvReady(),
          fallback,
        },
        plan !== "pro"
          ? "RENDER_BACKEND=lambda requested for a non-Pro plan — degrading"
          : "RENDER_BACKEND=lambda but AWS env (AWS_REGION + HYPERFRAMES_S3_BUCKET) is incomplete — degrading",
      );
      return fallback;
    }

    case "auto":
      // Prefer the richest backend available to this plan, silently (auto is
      // explicitly "give me the best you've got", so a missing tier isn't a
      // misconfiguration worth warning about).
      if (lambdaEligible) return "lambda";
      return bestNonLambda();
  }
}

/**
 * True when the lambda backend COULD be active in this process for some Pro
 * render — i.e. the operator opted in (RENDER_BACKEND lambda|auto) AND the AWS
 * env is present. Used by the progress poller to no-op entirely when lambda is
 * not in play, regardless of any individual plan. Plan is NOT considered here:
 * a poller must run if ANY lambda job could exist, and only Pro users can create
 * them, so env-readiness + opt-in is the right gate.
 */
export function isLambdaBackendActive(): boolean {
  const preference = readPreference();
  if (preference !== "lambda" && preference !== "auto") return false;
  return lambdaEnvReady();
}
