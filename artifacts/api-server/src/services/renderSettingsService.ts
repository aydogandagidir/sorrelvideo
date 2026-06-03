/**
 * Render settings: resolve, gate, and adapt to the Hyperframes engine.
 *
 * Single source of truth for the Free/Pro capability matrix and the one
 * adapter (`toEngineConfig`) that maps the app's `RenderSettings` to the
 * engine's `RenderConfig`. Pure + DB-less so it unit-tests trivially; the
 * route layer owns auth/HTTP and calls `assertRenderSettingsAllowed` both
 * when settings are saved AND at render time (defense in depth — a user who
 * downgrades must not render a previously-saved Pro config).
 */
import type { RenderConfig } from "@hyperframes/producer";
import {
  DEFAULT_RENDER_SETTINGS,
  type RenderSettings,
  type RenderResolution,
  type RenderQuality,
  type RenderFormat,
  type RenderFps,
} from "@workspace/db";

const QUALITIES: readonly RenderQuality[] = ["draft", "standard", "high"];
const FORMATS: readonly RenderFormat[] = ["mp4", "webm", "mov", "png-sequence"];
const FPS_VALUES: readonly RenderFps[] = [24, 30, 60];
const RESOLUTIONS: readonly RenderResolution[] = [
  "landscape",
  "portrait",
  "square",
  "landscape-4k",
  "portrait-4k",
  "square-4k",
];

/**
 * Pixel dimensions per resolution preset. Mirrors `@hyperframes/core`'s
 * `CANVAS_DIMENSIONS` (verified against 0.6.6) but kept local on purpose:
 * core's ESM `dist` uses extensionless relative imports that Node's native
 * ESM loader (used by vitest) can't resolve, so importing a runtime value from
 * core breaks unit tests. When M3/M4 need runtime core (compiler/lint), add
 * `server.deps.inline: [/@hyperframes\/core/]` to vitest.config.ts and this can
 * switch back to the import.
 */
const CANVAS_DIMENSIONS: Record<
  RenderResolution,
  { width: number; height: number }
> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  "landscape-4k": { width: 3840, height: 2160 },
  "portrait-4k": { width: 2160, height: 3840 },
  "square-4k": { width: 2160, height: 2160 },
};

/**
 * Thrown by `assertRenderSettingsAllowed` when a Free user requests a Pro-only
 * capability. The route maps `reason` to a 403 `{ reason: "upgrade_required" }`,
 * byte-identical to the existing premium-template / quota rejections.
 */
export class RenderSettingsUpgradeError extends Error {
  readonly reason = "upgrade_required" as const;
  readonly status = 403 as const;
  constructor(message: string) {
    super(message);
    this.name = "RenderSettingsUpgradeError";
  }
}

/**
 * Coerce a raw (possibly partial / malformed) settings object — e.g. from the
 * `render_settings` jsonb column or an untrusted request body — into a complete,
 * valid `RenderSettings`. Unknown/invalid fields fall back to the defaults, so a
 * null column reproduces today's render output exactly.
 */
export function resolveSettings(
  raw: Partial<RenderSettings> | null | undefined,
): RenderSettings {
  const r = raw ?? {};
  return {
    fps: FPS_VALUES.includes(r.fps as RenderFps)
      ? (r.fps as RenderFps)
      : DEFAULT_RENDER_SETTINGS.fps,
    quality: QUALITIES.includes(r.quality as RenderQuality)
      ? (r.quality as RenderQuality)
      : DEFAULT_RENDER_SETTINGS.quality,
    format: FORMATS.includes(r.format as RenderFormat)
      ? (r.format as RenderFormat)
      : DEFAULT_RENDER_SETTINGS.format,
    resolution: RESOLUTIONS.includes(r.resolution as RenderResolution)
      ? (r.resolution as RenderResolution)
      : DEFAULT_RENDER_SETTINGS.resolution,
    transparent:
      typeof r.transparent === "boolean"
        ? r.transparent
        : DEFAULT_RENDER_SETTINGS.transparent,
    watermark:
      typeof r.watermark === "boolean"
        ? r.watermark
        : DEFAULT_RENDER_SETTINGS.watermark,
    ...(Array.isArray(r.transitions) ? { transitions: r.transitions } : {}),
  };
}

/**
 * Free/Pro gate. No-op for Pro. For Free, throws `RenderSettingsUpgradeError`
 * listing every Pro-only knob in use. Free floor = today's behavior
 * (draft/standard, 24-30fps, ≤1080p, mp4, opaque, watermarked, ≤1 transition).
 */
export function assertRenderSettingsAllowed(
  settings: RenderSettings,
  plan: "free" | "pro",
): void {
  if (plan === "pro") return;

  const proOnly: string[] = [];
  if (settings.quality === "high") proOnly.push("High quality");
  if (settings.fps === 60) proOnly.push("60 fps");
  if (settings.resolution.endsWith("-4k")) proOnly.push("4K resolution");
  if (settings.format !== "mp4") proOnly.push(`${settings.format} export`);
  if (settings.transparent) proOnly.push("Transparent background");
  if (!settings.watermark) proOnly.push("Watermark removal");
  if ((settings.transitions?.length ?? 0) > 1)
    proOnly.push("Multiple transitions");

  if (proOnly.length > 0) {
    throw new RenderSettingsUpgradeError(
      `${proOnly.join(", ")} require the Pro plan`,
    );
  }
}

/**
 * Whether a container format can carry a true alpha channel. mp4 is always
 * opaque (H.264/H.265); webm (VP9 yuva420p), mov (ProRes 4444), and
 * png-sequence (RGBA) all carry alpha. Mirrors the producer's
 * `needsAlpha = webm | mov | png-sequence` and the frontend's
 * `formatSupportsAlpha`.
 */
export function formatSupportsAlpha(format: RenderFormat): boolean {
  return format !== "mp4";
}

/** Pixel dimensions for a resolution preset (from the engine's CANVAS_DIMENSIONS). */
export function resolveDimensions(resolution: RenderResolution): {
  width: number;
  height: number;
} {
  return CANVAS_DIMENSIONS[resolution];
}

/**
 * Map app `RenderSettings` to the engine's `RenderConfig`. The single adapter
 * that replaces the previously hardcoded `{ fps: {num:30,den:1} as Fps,
 * quality: "draft", entryFile }`. `fps` is the exact rational the engine wants;
 * `outputResolution` reuses the shared CanvasResolution names.
 *
 * TRANSPARENT BACKGROUND is *format-derived*, not a separate config field. The
 * producer (verified against 0.6.6) computes `needsAlpha = webm | mov |
 * png-sequence` and, for those formats, auto-injects transparent-background CSS
 * (`initTransparentBackground`) + forces screenshot capture — there is NO
 * `RenderConfig.transparent` knob to set. So `settings.transparent` is realized
 * purely by the chosen `format`, and the two are kept coherent upstream:
 *   - the Free/Pro gate (`assertRenderSettingsAllowed`) makes any non-mp4 format
 *     AND `transparent` Pro-only, and
 *   - the editor (`render-settings-form.tsx`) forces `transparent → false`
 *     whenever the format can't carry alpha (mp4),
 * so `transparent: true` always implies an alpha-capable format here. We assert
 * that invariant defensively rather than silently shipping an mp4 the user
 * thinks is transparent. (The Lambda backend, a *different* transport, does take
 * an explicit `transparent` boolean — see `lambdaBackend.ts`; that is its own
 * contract and unrelated to this inline/bullmq engine config.)
 *
 * `outputResolution` IS OMITTED FOR ALPHA FORMATS. The engine's
 * `resolveDeviceScaleFactor` THROWS when `outputResolution` is combined with
 * alpha output ("the alpha screenshot path does not yet apply deviceScaleFactor")
 * — so passing the resolution preset on a webm/mov/png-sequence render would
 * hard-fail the very transparent render the user asked for. Alpha output is
 * therefore produced at the composition's authored dimensions (the engine's
 * documented guidance: "Render alpha at composition resolution and upscale
 * separately"). For opaque mp4 the preset is forwarded unchanged, so the default
 * (mp4 / portrait) render is byte-for-byte as before.
 */
export function toEngineConfig(
  settings: RenderSettings,
  entryFile: string,
): RenderConfig {
  const alpha = formatSupportsAlpha(settings.format);
  if (settings.transparent && !alpha) {
    throw new Error(
      `Transparent background requires an alpha-capable format (webm/mov/png-sequence), got "${settings.format}"`,
    );
  }
  return {
    fps: { num: settings.fps, den: 1 },
    quality: settings.quality,
    format: settings.format,
    entryFile,
    // Alpha output forbids a deviceScaleFactor override; omit it there.
    ...(alpha ? {} : { outputResolution: settings.resolution }),
  };
}
