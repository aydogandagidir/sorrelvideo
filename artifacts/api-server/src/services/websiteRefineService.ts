import { getProvider } from "@workspace/ai";
import { checkAndIncrementAiCount } from "./billingService";
import { buildCropVars, regionCrop } from "../lib/websiteCrop";

/**
 * "Fix it in the preview" for a website→video showcase: a natural-language
 * instruction → a SMALL set of changed compositionVars (a new length and/or a
 * featured region), so the SPA can live-preview the change via `?vars=` and the
 * user refines without a blind regenerate. The model returns only bounded knobs
 * (duration number + region enum, never geometry); this service clamps the
 * duration and maps the region to a server-computed crop — the same trust model
 * as the AI section tour (`pickSections`).
 *
 * Returns ONLY the changed vars (merged OVER the project's saved vars by the
 * preview/render path), never the whole map — so the big `capture.image` data
 * URI stays server-side and the `?vars=` override stays tiny.
 */

const SHOWCASE_MODULE = "website-showcase";
// Mirror the showcase duration bounds in websiteToVideoService (3s floor keeps
// the fixed intro/outro from colliding; 60s ceiling bounds render cost).
const DURATION_MIN = 3;
const DURATION_MAX = 60;
const FALLBACK_DURATION = 9;

function clampDuration(raw: number): number {
  return Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(raw)));
}

/** The refine isn't applicable to this project (wrong module / uses an AI tour). */
export class RefineNotApplicableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineNotApplicableError";
  }
}

export interface RefineResult {
  /** The changed compositionVars (a partial map), for the live-preview `?vars=`. */
  vars: Record<string, string>;
  /** One short sentence describing the change, in the instruction's language. */
  note: string;
}

/**
 * Compute the refined vars for a website→video project. The CALLER loads the
 * project + enforces auth/ownership (so this stays DB-free and unit-testable);
 * here we validate applicability, call the provider, charge AI quota AFTER a
 * successful generation (mirrors /ai/edit — a provider failure never burns a
 * Free unit), and map the model's bounded output to changed vars.
 *
 * Throws RefineNotApplicableError (→ 422) for a non-showcase or AI-tour project,
 * a quota error with `reason: "upgrade_required"` (→ 403) when over cap, and the
 * provider's own error (→ 502/503) when the LLM call fails.
 */
export async function refineWebsiteVideoVars(
  userId: string,
  project: { module: string; compositionVars: Record<string, string> | null },
  instruction: string,
): Promise<RefineResult> {
  if (project.module !== SHOWCASE_MODULE) {
    throw new RefineNotApplicableError(
      "Bu proje bir website→video değil; prompt ile düzeltme yalnız onlarda çalışır.",
    );
  }
  const vars = project.compositionVars ?? {};
  if (vars["capture.tour"]) {
    throw new RefineNotApplicableError(
      "Bu video bir AI tur kullanıyor; tur düzenleme bir sonraki adımda gelecek.",
    );
  }

  const durationSeconds = Number(vars["duration"]) || FALLBACK_DURATION;
  const captureHeight = Number(vars["capture.height"]) || 0;

  const out = await getProvider().refineWebsiteVideo({
    instruction,
    current: { durationSeconds, captureHeight },
  });

  // Charge quota only AFTER a successful provider call (mirrors /ai/edit). May
  // throw `{ reason: "upgrade_required" }`, which the route maps to a 403.
  await checkAndIncrementAiCount(userId);

  const changed: Record<string, string> = {};
  // 0 (or anything below the floor) = "leave the length unchanged".
  if (out.duration && out.duration >= DURATION_MIN) {
    changed["duration"] = String(clampDuration(out.duration));
  }
  // "keep" leaves the framing untouched; any other region resets the crop vars.
  if (out.region !== "keep") {
    Object.assign(changed, buildCropVars(regionCrop(out.region, captureHeight)));
  }

  return { vars: changed, note: out.note };
}
