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
 */
export function toEngineConfig(
  settings: RenderSettings,
  entryFile: string,
): RenderConfig {
  return {
    fps: { num: settings.fps, den: 1 },
    quality: settings.quality,
    format: settings.format,
    entryFile,
    outputResolution: settings.resolution,
  };
}
