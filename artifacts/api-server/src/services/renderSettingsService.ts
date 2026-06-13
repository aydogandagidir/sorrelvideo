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
  type RenderCaptionWord,
  type RenderVoiceover,
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
 * `CANVAS_DIMENSIONS` (verified against 0.6.91) but kept local on purpose:
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
/** Clamp a raw volume to the 0–100 integer range (default 50). */
function clampAudioVolume(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Coerce a raw captions blob into a clean `{ words }` (or undefined). Keeps only
 * well-formed words (non-empty text, finite end > start ≥ 0), caps the count to
 * bound the injected overlay, and drops everything else. Untrusted text is
 * HTML-escaped later at injection (renderService), not here.
 */
function sanitizeCaptions(
  raw: unknown,
): { words: RenderCaptionWord[] } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const words = (raw as { words?: unknown }).words;
  if (!Array.isArray(words)) return undefined;
  const clean: RenderCaptionWord[] = [];
  for (const w of words) {
    if (!w || typeof w !== "object") continue;
    const ww = w as { text?: unknown; start?: unknown; end?: unknown };
    const text = typeof ww.text === "string" ? ww.text.slice(0, 200) : "";
    const start =
      typeof ww.start === "number" && Number.isFinite(ww.start)
        ? Math.max(0, ww.start)
        : 0;
    const end =
      typeof ww.end === "number" && Number.isFinite(ww.end)
        ? Math.max(0, ww.end)
        : 0;
    if (text.length > 0 && end > start) clean.push({ text, start, end });
  }
  return clean.length > 0 ? { words: clean.slice(0, 2000) } : undefined;
}

/**
 * Coerce a raw voiceover blob (talking-host narration) into a clean
 * `RenderVoiceover` (or undefined). CRITICAL: `resolveSettings` rebuilds the
 * settings object field-by-field, so without this block a stored voiceover is
 * silently DROPPED on the render path (executeRender re-resolves the jsonb)
 * and erased by any later render-settings PATCH merge — shipping a mute
 * talking-host video. `objectPath` must be null (local render-dir copy only)
 * or a "/objects/"-shaped string; ownership is re-checked at render time.
 */
function sanitizeVoiceover(raw: unknown): RenderVoiceover | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as { objectPath?: unknown; startAt?: unknown; volume?: unknown };
  const objectPath =
    typeof v.objectPath === "string" && v.objectPath.startsWith("/objects/")
      ? v.objectPath
      : v.objectPath === null
        ? null
        : undefined;
  if (objectPath === undefined) return undefined;
  const startAt =
    typeof v.startAt === "number" && Number.isFinite(v.startAt)
      ? Math.max(0, Math.min(600, v.startAt))
      : 0;
  return {
    objectPath,
    startAt,
    volume: clampAudioVolume(v.volume ?? 100),
  };
}

export function resolveSettings(
  raw: Partial<RenderSettings> | null | undefined,
): RenderSettings {
  const r = raw ?? {};
  const captions = sanitizeCaptions(r.captions);
  const voiceover = sanitizeVoiceover(r.voiceover);
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
    // Background audio (Track C): keep only a well-formed, "/objects/"-shaped
    // path. Ownership is enforced at the route AND re-checked at render time
    // (which skips silently on any failure); volume is clamped 0–100.
    ...(r.backgroundAudio &&
    typeof r.backgroundAudio.objectPath === "string" &&
    r.backgroundAudio.objectPath.startsWith("/objects/")
      ? {
          backgroundAudio: {
            objectPath: r.backgroundAudio.objectPath,
            volume: clampAudioVolume(r.backgroundAudio.volume),
          },
        }
      : {}),
    ...(captions ? { captions } : {}),
    ...(voiceover ? { voiceover } : {}),
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
  if (settings.backgroundAudio) proOnly.push("Background audio");
  if (settings.captions?.words?.length) proOnly.push("Captions");
  // `voiceover` is deliberately NOT Pro-gated: the talking-host flow that sets
  // it is metered by an AI quota unit at creation + the render quota. Gating it
  // here would 403 every Free auto-render AFTER the AI unit was already spent
  // (this assert re-runs at render time), stranding a draft the user paid for.

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
 * producer (verified against 0.6.91) computes `needsAlpha = webm | mov |
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
 *
 * `workers` is capped (env `RENDER_WORKERS`, default 2). The producer otherwise
 * auto-calibrates the worker count to the host CPU count — observed as 6 on
 * Railway — and each worker drives its own headless-Chrome context. Six of them
 * OOM-crash a small container (Railway Free/Hobby) the instant a render starts,
 * which surfaces to the user as "Render interrupted by a restart", a swscaler
 * encode failure under memory pressure, or a 502 while the box is pinned. A low,
 * env-tunable default keeps a single render from taking the whole instance down;
 * raise `RENDER_WORKERS` on a larger box for faster renders.
 */
const DEFAULT_RENDER_WORKERS = 2;

function resolveRenderWorkers(): number {
  const raw = Number(process.env.RENDER_WORKERS);
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : DEFAULT_RENDER_WORKERS;
}

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
    // Cap parallel render workers so one render can't OOM-crash a small box.
    workers: resolveRenderWorkers(),
    // Alpha output forbids a deviceScaleFactor override; omit it there.
    ...(alpha ? {} : { outputResolution: settings.resolution }),
  };
}
