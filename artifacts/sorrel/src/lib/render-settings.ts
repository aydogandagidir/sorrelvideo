/**
 * Render-settings catalogs + the Free/Pro capability matrix, client-side.
 *
 * Pure and dependency-free (besides the generated API types) so it can be
 * reused by Studio today and Bulk later. The gating helpers MIRROR the server's
 * `assertRenderSettingsAllowed` (artifacts/api-server/src/services/
 * renderSettingsService.ts) — the server stays authoritative, this is only an
 * eager UX gate so a Free user sees disabled controls + an upgrade nudge before
 * the PATCH 403s. Keep the two in lockstep.
 *
 * Types come from the generated client (`@workspace/api-client-react`, sourced
 * from OpenAPI). We never invent shapes here.
 */
import {
  type RenderSettings,
  type RenderTransition,
  RenderSettingsQuality,
  RenderSettingsFps,
  RenderSettingsFormat,
  RenderSettingsResolution,
} from "@workspace/api-client-react";

export type {
  RenderSettings,
  RenderTransition,
} from "@workspace/api-client-react";

export type RenderQuality = RenderSettings["quality"];
export type RenderFps = RenderSettings["fps"];
export type RenderFormat = RenderSettings["format"];
export type RenderResolution = RenderSettings["resolution"];

/** A render-settings field that can be individually Pro-gated. */
export type ProGatedField =
  | "quality"
  | "fps"
  | "format"
  | "resolution"
  | "transparent"
  | "watermark"
  | "transitions"
  | "backgroundAudio"
  | "captions";

interface Option<T> {
  value: T;
  label: string;
  /** Optional secondary line (e.g. pixel dimensions). */
  hint?: string;
}

export const QUALITY_OPTIONS: ReadonlyArray<Option<RenderQuality>> = [
  { value: RenderSettingsQuality.draft, label: "Draft", hint: "Fastest" },
  { value: RenderSettingsQuality.standard, label: "Standard" },
  { value: RenderSettingsQuality.high, label: "High", hint: "Best quality" },
];

export const FPS_OPTIONS: ReadonlyArray<Option<RenderFps>> = [
  { value: RenderSettingsFps.NUMBER_24, label: "24" },
  { value: RenderSettingsFps.NUMBER_30, label: "30" },
  { value: RenderSettingsFps.NUMBER_60, label: "60" },
];

export const FORMAT_OPTIONS: ReadonlyArray<Option<RenderFormat>> = [
  { value: RenderSettingsFormat.mp4, label: "MP4", hint: "H.264 video" },
  { value: RenderSettingsFormat.webm, label: "WebM", hint: "Alpha capable" },
  { value: RenderSettingsFormat.mov, label: "MOV", hint: "ProRes / alpha" },
  {
    value: RenderSettingsFormat["png-sequence"],
    label: "PNG sequence",
    hint: "Frames + alpha",
  },
];

/**
 * The six resolution presets. Each encodes BOTH aspect ratio and tier; pixel
 * dimensions mirror the engine's CANVAS_DIMENSIONS (verified @hyperframes/core
 * 0.6.6 and the server's `resolveDimensions`).
 */
export const RESOLUTION_OPTIONS: ReadonlyArray<Option<RenderResolution>> = [
  {
    value: RenderSettingsResolution.landscape,
    label: "Landscape 16:9",
    hint: "1920×1080",
  },
  {
    value: RenderSettingsResolution.portrait,
    label: "Portrait 9:16",
    hint: "1080×1920",
  },
  {
    value: RenderSettingsResolution.square,
    label: "Square 1:1",
    hint: "1080×1080",
  },
  {
    value: RenderSettingsResolution["landscape-4k"],
    label: "Landscape 4K",
    hint: "3840×2160",
  },
  {
    value: RenderSettingsResolution["portrait-4k"],
    label: "Portrait 4K",
    hint: "2160×3840",
  },
  {
    value: RenderSettingsResolution["square-4k"],
    label: "Square 4K",
    hint: "2160×2160",
  },
];

/**
 * Aspect-ratio / publishing-target presets. The three base (non-4K) resolutions,
 * framed as "where will you post this" — the platform-led mental model real video
 * tools use (CapCut/Veed "resize for"). Maps a friendly platform choice to the
 * project's render `resolution` and a CSS aspect-ratio for framing previews.
 */
export interface AspectPreset {
  value: RenderResolution;
  ratio: string; // "9:16"
  label: string; // "Portrait"
  platforms: string; // "TikTok · Reels · Shorts"
  aspect: string; // CSS aspect-ratio, e.g. "9 / 16"
}

export const ASPECT_PRESETS: ReadonlyArray<AspectPreset> = [
  {
    value: RenderSettingsResolution.portrait,
    ratio: "9:16",
    label: "Portrait",
    platforms: "TikTok · Reels · Shorts",
    aspect: "9 / 16",
  },
  {
    value: RenderSettingsResolution.landscape,
    ratio: "16:9",
    label: "Landscape",
    platforms: "YouTube · Web",
    aspect: "16 / 9",
  },
  {
    value: RenderSettingsResolution.square,
    ratio: "1:1",
    label: "Square",
    platforms: "Instagram · Feed",
    aspect: "1 / 1",
  },
];

/** CSS aspect-ratio for any resolution preset (4K variants share their base aspect). */
export function aspectRatioFor(resolution: RenderResolution): string {
  if (resolution.startsWith("landscape")) return "16 / 9";
  if (resolution.startsWith("square")) return "1 / 1";
  return "9 / 16";
}

/** The base (non-4K) aspect a resolution belongs to — used to highlight the selected pill. */
export function baseAspect(resolution: RenderResolution): RenderResolution {
  if (resolution.startsWith("landscape")) return RenderSettingsResolution.landscape;
  if (resolution.startsWith("square")) return RenderSettingsResolution.square;
  return RenderSettingsResolution.portrait;
}

/**
 * The 15 shader transition names (verified @hyperframes/core 0.6.6). A row in
 * the transition picker maps `shader` to one of these.
 */
export const TRANSITION_SHADERS = [
  "domain-warp",
  "ridged-burn",
  "whip-pan",
  "sdf-iris",
  "ripple-waves",
  "gravitational-lens",
  "cinematic-zoom",
  "chromatic-split",
  "glitch",
  "swirl-vortex",
  "thermal-distortion",
  "flash-through-white",
  "cross-warp-morph",
  "light-leak",
  "fade-dissolve",
] as const;

export type TransitionShader = (typeof TRANSITION_SHADERS)[number];

/** Human label for a shader id ("whip-pan" → "Whip Pan"). */
export function shaderLabel(shader: string): string {
  return shader
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** GSAP easing names offered in the transition picker. */
export const EASE_OPTIONS = [
  "linear",
  "power1.in",
  "power1.out",
  "power1.inOut",
  "power2.in",
  "power2.out",
  "power2.inOut",
  "power3.inOut",
  "back.out",
  "expo.out",
  "sine.inOut",
] as const;

export type EaseName = (typeof EASE_OPTIONS)[number];

/**
 * Formats that can carry an alpha channel. `transparent` is only meaningful for
 * these; on mp4 the toggle is disabled in the UI.
 */
const ALPHA_CAPABLE_FORMATS: ReadonlySet<RenderFormat> = new Set<RenderFormat>([
  RenderSettingsFormat.webm,
  RenderSettingsFormat.mov,
  RenderSettingsFormat["png-sequence"],
]);

export function formatSupportsAlpha(format: RenderFormat): boolean {
  return ALPHA_CAPABLE_FORMATS.has(format);
}

/** A new transition pre-filled with sensible defaults. */
export function defaultTransition(): RenderTransition {
  return { time: 0, shader: TRANSITION_SHADERS[0], duration: 0.5, ease: "power2.inOut" };
}

/**
 * Defaults applied when a project has no saved render settings. Mirrors
 * `DEFAULT_RENDER_SETTINGS` in `@workspace/db` (draft / 30 / mp4 / portrait /
 * opaque / watermarked) — the byte-for-byte pre-settings render output.
 */
export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  fps: RenderSettingsFps.NUMBER_30,
  quality: RenderSettingsQuality.draft,
  format: RenderSettingsFormat.mp4,
  resolution: RenderSettingsResolution.portrait,
  transparent: false,
  watermark: true,
  transitions: [],
};

/**
 * The Free plan floor. Anything outside this set is Pro-only. This MUST stay in
 * lockstep with the server's `assertRenderSettingsAllowed`:
 *   quality draft|standard, fps 24|30, resolution non-4k, format mp4,
 *   transparent=false, watermark=true, ≤1 transition.
 */
export const FREE_MAX_TRANSITIONS = 1;

const FREE_QUALITIES: ReadonlySet<RenderQuality> = new Set<RenderQuality>([
  RenderSettingsQuality.draft,
  RenderSettingsQuality.standard,
]);

const FREE_FPS: ReadonlySet<RenderFps> = new Set<RenderFps>([
  RenderSettingsFps.NUMBER_24,
  RenderSettingsFps.NUMBER_30,
]);

function isFourK(resolution: RenderResolution): boolean {
  return resolution.endsWith("-4k");
}

/**
 * Is a specific field+value combination Pro-only? Used by the form to badge and
 * gate individual options for Free users. `value` is typed loosely because
 * callers pass per-field option values (and a transition *count* for the
 * "transitions" field); we narrow per branch.
 */
export function isProOnly(field: ProGatedField, value: unknown): boolean {
  switch (field) {
    case "quality":
      return !FREE_QUALITIES.has(value as RenderQuality);
    case "fps":
      return !FREE_FPS.has(value as RenderFps);
    case "resolution":
      return isFourK(value as RenderResolution);
    case "format":
      return value !== RenderSettingsFormat.mp4;
    case "transparent":
      // Only turning transparency ON is a Pro action.
      return value === true;
    case "watermark":
      // Removing the watermark (watermark = false) is the Pro action.
      return value === false;
    case "transitions":
      return (typeof value === "number" ? value : 0) > FREE_MAX_TRANSITIONS;
    case "backgroundAudio":
      // Any attached background audio track is a Pro feature.
      return value != null;
    case "captions":
      // Any captions are a Pro feature.
      return value != null;
    default:
      return false;
  }
}

/**
 * Every Pro-only capability currently selected in `settings`, as human strings.
 * Mirrors the server's `assertRenderSettingsAllowed` wording so the eager
 * client gate and the authoritative server rejection agree. Empty array → the
 * settings are valid on the Free plan.
 */
export function proViolations(settings: RenderSettings): string[] {
  const violations: string[] = [];
  if (isProOnly("quality", settings.quality)) violations.push("High quality");
  if (isProOnly("fps", settings.fps)) violations.push("60 fps");
  if (isProOnly("resolution", settings.resolution))
    violations.push("4K resolution");
  if (isProOnly("format", settings.format))
    violations.push(`${settings.format} export`);
  if (isProOnly("transparent", settings.transparent))
    violations.push("Transparent background");
  if (isProOnly("watermark", settings.watermark))
    violations.push("Watermark removal");
  if (isProOnly("transitions", settings.transitions?.length ?? 0))
    violations.push("Multiple transitions");
  if (isProOnly("backgroundAudio", settings.backgroundAudio ?? null))
    violations.push("Background audio");
  if (isProOnly("captions", settings.captions ?? null))
    violations.push("Captions");
  return violations;
}

/** Convenience: would these settings be rejected for a Free user? */
export function violatesFreePlan(settings: RenderSettings): boolean {
  return proViolations(settings).length > 0;
}
