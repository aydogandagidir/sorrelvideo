import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  createRenderJob,
  executeRenderJob,
  RenderCancelledError,
} from "@hyperframes/producer";
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  type RenderFormat,
  type RenderAudioTrack,
  type RenderCaptions,
  type RenderResolution,
  type RenderSettings,
  type RenderTransition,
  type RenderVoiceover,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { buildCaptionOverlay } from "../lib/captionStyles";
import { getBrandKit, getDefaultBrandKit } from "./brandKitService";
import {
  resolveSettings,
  toEngineConfig,
  resolveDimensions,
} from "./renderSettingsService";
import { decrementRenderCount } from "./billingService";
import {
  getJobById,
  getLatestJobForProject,
  isCancelRequested,
  markCancelled,
  markFailed,
  markProgress,
  markReady,
  markRendering,
} from "./renderJobsService";
import { generateThumbnail } from "./thumbnailService";
import { REGISTRY_COMPOSITION_MAP, assetsForModule } from "./registryTemplates";
import { ObjectStorageService } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";

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

export const COMPOSITIONS_DIR = firstExistingDir(
  [
    path.resolve(__dirname, "compositions"), // bundled next to dist (if copied)
    path.resolve(__dirname, "../compositions"), // prod Docker: /app/compositions
    path.resolve(__dirname, "../src/compositions"), // dev: dist/../src/compositions
    path.resolve(__dirname, "../../src/compositions"), // source layout
  ],
  path.resolve(__dirname, "../compositions"),
);

/**
 * Copy a module's vendored sibling assets (compositions/assets/<module>/<name>)
 * into a per-render directory's `assets/` subdir so the engine resolves the
 * composition's relative `assets/<name>` refs. Only the manifest-declared names
 * are copied (the allow-list), one file at a time — NOT a recursive dir copy —
 * so the manifest stays the source of truth. A missing committed asset is a
 * packaging bug, so this throws loudly (like the voiceover path) rather than
 * silently shipping a broken render. No-op for modules with no assets.
 */
export function copyTemplateAssets(module: string, destDir: string): void {
  const names = assetsForModule(module);
  if (names.length === 0) return;
  const srcDir = path.join(COMPOSITIONS_DIR, "assets", module);
  const outDir = path.join(destDir, "assets");
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));
  }
}

const COMPOSITION_MAP: Record<string, string> = {
  "product-launch": "product-launch.html",
  "brand-promo": "brand-promo.html",
  "social-teaser": "social-teaser.html",
  studio: "studio-default.html",
  ai: "social-teaser.html",
  bulk: "brand-promo.html",
  // website→video: the captured screenshot is injected via compositionVars
  // (capture.image data URI + capture.height/title/url) by websiteToVideoService.
  "website-showcase": "website-showcase.html",
  // script→video: the TTS narration + Whisper word timings are injected via
  // compositionVars (base64 host.payload) by talkingHostService; the voiceover
  // file itself is a render-dir sibling muxed via RenderSettings.voiceover.
  "talking-host": "talking-host.html",
  // Hand-authored showcase templates (M-features Track B): exercise the engine's
  // Three.js/WebGL and Lottie adapters, which no template used before.
  "product-3d": "product-3d.html",
  "lottie-reveal": "lottie-reveal.html",
  "video-spotlight": "video-spotlight.html",
  // First transition-capable template (M8): two .scene elements + a declared
  // data-scene-boundary; RenderSettings.transitions composite a shader across
  // the boundary via the injected @hyperframes/shader-transitions bootstrap.
  "brand-story": "brand-story.html",
  // Vendored Hyperframes registry blocks (Apache-2.0): each platform template's
  // `module` is its slug, resolving to the same-named <slug>.html composition.
  ...REGISTRY_COMPOSITION_MAP,
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
  // Per-render canvas dimensions + aspect class. Default = the authored portrait
  // canvas, so a no-vars / null-settings render is byte-identical to before.
  // buildCompositionHtml overrides these from the project's render resolution so
  // the composition authors itself at the SAME aspect the engine outputs — which
  // is what stops the engine's aspect-mismatch throw for landscape/square picks.
  "layout.width": "1080",
  "layout.height": "1920",
  "layout.aspect": "portrait",
  // website-showcase reads {{duration}} (data-duration + the GSAP timeline). New
  // captures always set it from the user's choice; this default keeps a legacy
  // website-showcase project (created before duration was selectable) rendering at
  // its original 9s instead of leaving the placeholder unresolved.
  duration: "9",
  // Scene-transition handshake (M8): transition-capable compositions branch on
  // this to decide who owns the scene boundary — "0" (default: previews, no
  // transitions configured) → the composition wires its own hard cut; "1"
  // (render path, transitions active) → the injected HyperShader bootstrap
  // owns the boundary. The default keeps the live-preview route and every
  // transitionless render byte-identical in behavior.
  "sorrel.transitionsActive": "0",
} as const;

/** Resolve the HTML composition filename for a given module slug. */
export function resolveEntryFile(module: string): string {
  return COMPOSITION_MAP[module] ?? DEFAULT_COMPOSITION;
}

/**
 * True when a module is a KNOWN composition (has its own entry in
 * COMPOSITION_MAP), as opposed to `resolveEntryFile`'s default-fallback. The
 * module-keyed preview route uses this to 404 an unknown module rather than
 * silently serving the default composition.
 */
export function isKnownModule(module: string): boolean {
  return module in COMPOSITION_MAP;
}

/**
 * The per-project render directory (`renders/<projectId>`). Exported so flows
 * that stage sibling files BEFORE a render (talkingHostService writes the TTS
 * `voice.mp3` at creation time) resolve the exact directory the pipeline reads.
 */
export function renderDirFor(projectId: number): string {
  return path.join(RENDERS_DIR, String(projectId));
}

/** Fixed filename of the talking-host narration inside the render dir. */
export const VOICEOVER_FILENAME = "voice.mp3";

/** Output filename per single-file format (png-sequence is a directory). */
const OUTPUT_FILENAME: Record<Exclude<RenderFormat, "png-sequence">, string> = {
  mp4: "output.mp4",
  webm: "output.webm",
  mov: "output.mov",
  gif: "output.gif",
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

/**
 * A static "Made with Sorrel" watermark badge. Burned into the composition HTML
 * just before `</body>` when render settings have `watermark: true` (always true
 * for Free — the monetization lever — and removable on Pro). It is the
 * REVENUE-CRITICAL gate: a Free render with no badge is unmonetized.
 *
 * Design constraints (kept deliberately simple so the overlay is deterministic
 * and self-contained — no external asset/CDN, no per-frame variation):
 *  - `position: fixed` bottom-right, small, `pointer-events: none`.
 *  - Very high `z-index` so a composition's own stacking can't bury it.
 *  - Web-safe inline font stack + inline styles only, so it renders identically
 *    in the headless Chrome that rasterizes frames with no font/asset loading.
 *  - A subtle translucent dark pill keeps the white text legible over both light
 *    and dark compositions; the whole badge is semi-transparent so it doesn't
 *    dominate the frame.
 *  - Survives alpha output: the engine's transparent-background CSS only zeroes
 *    `html,body,[data-composition-id]` backgrounds, which this badge is not.
 *
 * `data-sorrel-watermark` marks the node so the absence/presence is trivially
 * assertable (tests + the visual check) without depending on the copy.
 */
const WATERMARK_HTML = `<div data-sorrel-watermark="true" aria-hidden="true" style="position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:9999px;background:rgba(15,23,42,0.55);color:rgba(255,255,255,0.92);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;line-height:1;font-weight:600;letter-spacing:0.01em;opacity:0.85;text-shadow:0 1px 2px rgba(0,0,0,0.35);">Made with Sorrel</div>`;

/**
 * Inject the watermark badge immediately before the LAST `</body>` so it paints
 * on top of the composition. Case-insensitive match. If a composition somehow
 * has no closing body tag (none do today — verified), the badge is appended so
 * the watermark is never silently dropped. Pure; callers decide whether to call
 * it based on resolved settings.
 */
export function injectWatermark(html: string): string {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html + WATERMARK_HTML;
  return html.slice(0, idx) + WATERMARK_HTML + html.slice(idx);
}

/** Insert `snippet` immediately before the last `</body>` (mirrors injectWatermark). */
function injectBeforeBodyEnd(html: string, snippet: string): string {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

/** Map an uploaded audio object's content-type to a file extension. */
function audioExtForContentType(contentType: string | undefined): string {
  switch ((contentType ?? "").toLowerCase()) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/mp4":
    case "audio/aac":
      return "m4a";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    default:
      return "mp3";
  }
}

/**
 * Resolve a project's background-audio track into an `<audio>` tag for the
 * engine to mux. The user-uploaded object is DOWNLOADED into the render dir as a
 * sibling file — the proven, ffmpeg-readable form (a `data:` URI is NOT muxed,
 * verified against 0.6.91) — then referenced relatively so the engine's serve
 * stage hosts it for the audio mix. Ownership is re-checked here (defense in
 * depth); ANY failure (missing/!owned object, GCS unconfigured, download error)
 * logs and returns null so the render proceeds SILENTLY instead of failing.
 *
 * `data-duration` matches the composition's declared duration (the first
 * `data-duration` in the doc is the root composition's); the engine's
 * `audioPadTrim` then pads/trims the mixed audio to the exact video length.
 */
async function resolveBackgroundAudioTag(
  userId: string,
  audio: RenderAudioTrack,
  dir: string,
  compositionHtml: string,
): Promise<string | null> {
  try {
    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(audio.objectPath);
    const canRead = await storage.canAccessObjectEntity({
      userId,
      objectFile: file,
      requestedPermission: ObjectPermission.READ,
    });
    if (!canRead) {
      logger.warn(
        { userId, objectPath: audio.objectPath },
        "Background audio not owned by user; rendering silent",
      );
      return null;
    }
    const [meta] = await file.getMetadata();
    const filename = `bg-audio.${audioExtForContentType(
      meta.contentType as string | undefined,
    )}`;
    await file.download({ destination: path.join(dir, filename) });
    const volume = Math.max(0, Math.min(1, (audio.volume ?? 50) / 100)).toFixed(
      3,
    );
    const compDuration =
      compositionHtml.match(/data-duration="([\d.]+)"/)?.[1] ?? "30";
    return `<audio src="${filename}" data-start="0" data-duration="${compDuration}" data-track-index="0" data-volume="${volume}" loop></audio>`;
  } catch (err) {
    logger.warn(
      { err, userId, objectPath: audio.objectPath },
      "Background audio unavailable; rendering silent",
    );
    return null;
  }
}

/**
 * The talking-host narration could not be sourced from EITHER the local render
 * dir or object storage. Deliberately a hard failure (unlike background music's
 * silent fallback): a talking-host video without its voice is worthless, so the
 * render must fail loudly with an actionable message instead of shipping a mute
 * MP4. `executeRender`'s catch converts this into project `failed` +
 * `renderError` + the automatic Free render-quota refund.
 */
export class VoiceoverUnavailableError extends Error {
  constructor() {
    super("Voiceover audio unavailable — recreate the video from the Avatar page");
    this.name = "VoiceoverUnavailableError";
  }
}

/**
 * Resolve the talking-host narration into an `<audio>` tag for the engine to
 * mux. Source preference: the local `renders/<id>/voice.mp3` sibling written at
 * creation time (works with zero GCS config), else the durable GCS object
 * (`voiceover.objectPath`, ownership re-checked) downloaded into place. Neither
 * → throw (see VoiceoverUnavailableError — no silent fallback by design).
 *
 * The tag deliberately has NO `loop` (narration must never restart inside a
 * longer composition) and uses `data-track-index="1"` so a background-music
 * track (index 0) can be layered under it later. `data-duration` matches the
 * composition's declared duration; the engine's `audioPadTrim` pads/trims the
 * mix to the exact video length.
 */
export async function resolveVoiceoverTag(
  userId: string,
  voiceover: RenderVoiceover,
  dir: string,
  compositionHtml: string,
): Promise<string> {
  const localPath = path.join(dir, VOICEOVER_FILENAME);
  if (!fs.existsSync(localPath)) {
    if (!voiceover.objectPath) throw new VoiceoverUnavailableError();
    try {
      const storage = new ObjectStorageService();
      const file = await storage.getObjectEntityFile(voiceover.objectPath);
      const canRead = await storage.canAccessObjectEntity({
        userId,
        objectFile: file,
        requestedPermission: ObjectPermission.READ,
      });
      if (!canRead) throw new Error("voiceover object not owned by user");
      await file.download({ destination: localPath });
    } catch (err) {
      logger.error(
        { err, userId, objectPath: voiceover.objectPath },
        "Voiceover audio unavailable — failing the render",
      );
      throw new VoiceoverUnavailableError();
    }
  }
  const volume = Math.max(0, Math.min(1, (voiceover.volume ?? 100) / 100)).toFixed(3);
  const startAt =
    typeof voiceover.startAt === "number" && Number.isFinite(voiceover.startAt)
      ? Math.max(0, voiceover.startAt)
      : 0;
  const compDuration =
    compositionHtml.match(/data-duration="([\d.]+)"/)?.[1] ?? "30";
  return `<audio src="${VOICEOVER_FILENAME}" data-start="${startAt}" data-duration="${compDuration}" data-track-index="1" data-volume="${volume}"></audio>`;
}

/**
 * Download a project's spotlight clip (the "/objects/..." path pinned in
 * `compositionVars["capture.videoObject"]`) into the render dir as the fixed
 * sibling `spotlight-video.mp4` the video-spotlight template references (the
 * engine composites it — verified on 0.6.91). Ownership is re-checked; ANY
 * failure logs and returns so the composition still renders its branded frame
 * WITHOUT the clip rather than failing the render.
 */
async function downloadSpotlightVideo(
  userId: string,
  objectPath: string,
  dir: string,
): Promise<boolean> {
  try {
    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(objectPath);
    const canRead = await storage.canAccessObjectEntity({
      userId,
      objectFile: file,
      requestedPermission: ObjectPermission.READ,
    });
    if (!canRead) {
      logger.warn(
        { userId, objectPath },
        "Spotlight video not owned by user; rendering without it",
      );
      return false;
    }
    await file.download({ destination: path.join(dir, "spotlight-video.mp4") });
    return true;
  } catch (err) {
    logger.warn(
      { err, userId, objectPath },
      "Spotlight video unavailable; rendering without it",
    );
    return false;
  }
}

/**
 * The `@hyperframes/shader-transitions` IIFE bundle (defines
 * `window.HyperShader`), read from node_modules and INLINED into the per-render
 * composition — the engine's file server only serves the render dir, and the
 * bundle is a browser artifact we must never import server-side (it inlines
 * html2canvas). `createRequire` resolution rides the package's `require`
 * condition (`dist/index.cjs`), then swaps to the sibling global build.
 * Memoized: the file is ~250 KB and immutable for the process lifetime.
 */
let shaderLibCache: string | null = null;
function readShaderTransitionsLib(): string {
  if (shaderLibCache !== null) return shaderLibCache;
  const entry = createRequire(import.meta.url).resolve(
    "@hyperframes/shader-transitions",
  );
  shaderLibCache = fs.readFileSync(
    path.join(path.dirname(entry), "index.global.js"),
    "utf-8",
  );
  return shaderLibCache;
}

/**
 * Build the shader-transitions injection (M8): the inlined HyperShader library
 * + a bootstrap that wires the user's `RenderSettings.transitions` onto the
 * composition's scene structure. Returns "" (transitions silently inactive,
 * composition keeps its own hard cut) unless ALL preconditions hold:
 *
 *  - ≥1 sanitized transition (content was validated by `sanitizeTransitions`);
 *  - the HTML declares ≥2 `class="scene"` elements (the server-side mirror of
 *    the bootstrap's runtime check — single-scene compositions like the
 *    studio seed can't host a scene transition);
 *  - the library file is readable.
 *
 * The bootstrap (browser-side, runs AFTER the composition's own script):
 *  - grabs the ROOT `window.__timelines[id]` and PASSES it to `init()` — the
 *    engine only seeks the root timeline, and init() without a timeline would
 *    REGISTER ITS OWN under the composition id, clobbering the real one;
 *  - collects non-root `.scene[id]` elements in DOM order as the scene list;
 *  - snaps a SINGLE transition onto the composition's declared boundary
 *    (`data-scene-boundary` on the root): start = boundary − duration/2, the
 *    upstream convention. Multiple transitions keep their user times;
 *  - maps Sorrel's `fade-dissolve` to the library's CSS-crossfade fallback by
 *    OMITTING the `shader` field;
 *  - reads `--sorrel-bg` / `--sorrel-accent` custom props for the shader
 *    background/accent colors (brand-derived in transition-capable templates);
 *  - on ANY failed precondition calls the composition's exported
 *    `window.__sorrelWireHardCuts()` so the boundary still cuts cleanly.
 */
export function buildTransitionsInjection(
  renderedHtml: string,
  transitions: RenderTransition[],
): string {
  if (transitions.length === 0) return "";
  const sceneCount = (renderedHtml.match(/class="[^"]*\bscene\b[^"]*"/g) ?? [])
    .length;
  if (sceneCount < 2) return "";

  let lib: string;
  try {
    lib = readShaderTransitionsLib();
  } catch (err) {
    logger.warn(
      { err },
      "shader-transitions library unavailable — rendering hard cut instead",
    );
    return "";
  }

  // JSON payload of the sanitized transitions; `<` escaped so a value can
  // never terminate the surrounding <script> (defense in depth — the
  // sanitizer's shader/ease whitelists already exclude `<`).
  const payload = JSON.stringify(
    transitions.map((t) => ({
      time: t.time,
      shader: t.shader,
      duration: t.duration,
      ease: t.ease,
    })),
  ).replace(/</g, "\\u003c");

  const bootstrap =
    `(function(){try{` +
    `var root=document.querySelector('[data-composition-id]');` +
    `var id=root&&root.getAttribute('data-composition-id');` +
    `var tl=id&&window.__timelines&&window.__timelines[id];` +
    `var scenes=Array.prototype.slice.call(document.querySelectorAll('.scene[id]')).filter(function(el){return el!==root;}).map(function(el){return el.id;});` +
    `if(!tl||typeof gsap==='undefined'||!window.HyperShader||scenes.length<2){if(window.__sorrelWireHardCuts)window.__sorrelWireHardCuts();return;}` +
    `var specs=${payload};` +
    `specs=specs.slice(0,Math.max(0,scenes.length-1));` +
    `if(!specs.length){if(window.__sorrelWireHardCuts)window.__sorrelWireHardCuts();return;}` +
    `var boundary=parseFloat(root.getAttribute('data-scene-boundary')||'');` +
    `var transitions=specs.map(function(t){` +
    `var start=(isFinite(boundary)&&specs.length===1)?Math.max(0,boundary-t.duration/2):t.time;` +
    `var spec={time:start,duration:t.duration,ease:t.ease};` +
    `if(t.shader!=='fade-dissolve')spec.shader=t.shader;` +
    `return spec;});` +
    `var styles=getComputedStyle(document.documentElement);` +
    `var bg=(styles.getPropertyValue('--sorrel-bg')||'').trim()||'#0b0b0f';` +
    `var accent=(styles.getPropertyValue('--sorrel-accent')||'').trim();` +
    `window.HyperShader.init({bgColor:bg,accentColor:accent||undefined,scenes:scenes.slice(0,transitions.length+1),transitions:transitions,timeline:tl,compositionId:id});` +
    `}catch(e){if(window.__sorrelWireHardCuts)window.__sorrelWireHardCuts();}})();`;

  return `<script>${lib}</script>\n<script>${bootstrap}</script>`;
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

/**
 * Resolve the brand kit a project renders with: the kit it pins
 * (`brandKitId`, ownership re-checked) when set and still owned, else the user's
 * default kit. Returns null only when the user has no kits at all (→
 * STUDIO_FALLBACKS). Users now have MANY kits, so a plain `WHERE user_id` would
 * be non-deterministic — go through brandKitService's default resolution.
 */
async function loadBrandKit(
  userId: string,
  brandKitId?: number | null,
): Promise<BrandKitSnapshot | null> {
  try {
    const row =
      (brandKitId != null ? await getBrandKit(userId, brandKitId) : null) ??
      (await getDefaultBrandKit(userId));
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
    logger.warn({ err, userId, brandKitId }, "Could not load brand kit");
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
  brandKitId?: number | null;
  renderSettings?: RenderSettings | null;
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

  const brand = await loadBrandKit(project.userId, project.brandKitId);
  const vars = buildVarMap(brand, project.compositionVars);

  // Author the composition canvas at the BASE pixel dimensions of the chosen
  // aspect (4K is realized by the engine's deviceScaleFactor, so strip the
  // `-4k`). The composition's CSS reads these as {{layout.*}} and reflows; the
  // engine's outputResolution shares this exact aspect, so its cross-multiply
  // aspect guard passes instead of throwing. Null settings → portrait (the
  // authored default) → byte-identical to the pre-aspect render.
  const settings = resolveSettings(project.renderSettings ?? null);
  const baseResolution = settings.resolution.replace(
    /-4k$/,
    "",
  ) as RenderResolution;
  const { width, height } = resolveDimensions(baseResolution);
  vars["layout.width"] = String(width);
  vars["layout.height"] = String(height);
  vars["layout.aspect"] =
    width > height ? "landscape" : width < height ? "portrait" : "square";

  return renderCompositionTemplate(source, vars);
}

/**
 * Materialize a per-render composition file with Studio variables already
 * substituted. Returns the directory + filename to feed Hyperframes.
 *
 * When `watermark` is true (resolved render settings; always true for Free) the
 * "Made with Sorrel" badge is burned into the HTML before it's written, so the
 * engine rasterizes it into every frame. The merge → substitution → watermark
 * order matters: the watermark is appended AFTER the template merge so it is
 * never substituted/escaped and always wins the stacking context.
 */
export async function prepareCompositionFor(
  project: {
    id: number;
    userId: string;
    module: string;
    compositionVars: Record<string, string> | null;
    compositionHtml?: string | null;
    brandKitId?: number | null;
    renderSettings?: RenderSettings | null;
  },
  options: {
    watermark: boolean;
    backgroundAudio?: RenderAudioTrack | null;
    captions?: RenderCaptions | null;
    voiceover?: RenderVoiceover | null;
    transitions?: RenderTransition[] | null;
  } = {
    watermark: true,
  },
): Promise<{ dir: string; file: string }> {
  // Scene transitions flip the handshake var BEFORE the template merge so the
  // composition skips its own hard-cut wiring (the injected bootstrap owns the
  // boundary — and hands ownership back via __sorrelWireHardCuts if any of its
  // preconditions fail at runtime).
  const transitionsActive = (options.transitions?.length ?? 0) > 0;
  let rendered = await buildCompositionHtml(
    transitionsActive
      ? {
          ...project,
          compositionVars: {
            ...(project.compositionVars ?? {}),
            "sorrel.transitionsActive": "1",
          },
        }
      : project,
  );
  if (options.watermark) rendered = injectWatermark(rendered);

  const dir = path.join(RENDERS_DIR, String(project.id));
  fs.mkdirSync(dir, { recursive: true });

  // Vendored sibling assets (multi-file registry blocks: social avatars, the
  // money-count sfx, code-snippet backgrounds): copy compositions/assets/<module>/*
  // into <dir>/assets/* so the composition's relative `assets/<name>` refs
  // resolve at render time. No-op for self-contained single-file modules.
  copyTemplateAssets(project.module, dir);

  // Video spotlight (Track D): replace the HERO_VIDEO marker with a <video> ONLY
  // when an uploaded clip is present + downloads OK. The engine HARD-FAILS if a
  // <video> can't decode its first frame, so a clip-less project must carry no
  // <video> at all — we strip the marker instead.
  if (rendered.includes("<!--HERO_VIDEO-->")) {
    const videoObject = project.compositionVars?.["capture.videoObject"];
    let heroTag = "";
    if (typeof videoObject === "string" && videoObject.startsWith("/objects/")) {
      const ok = await downloadSpotlightVideo(project.userId, videoObject, dir);
      if (ok) {
        const compDuration =
          rendered.match(/data-duration="([\d.]+)"/)?.[1] ?? "9";
        heroTag = `<video class="hero-video" src="spotlight-video.mp4" muted playsinline data-start="0" data-duration="${compDuration}"></video>`;
      }
    }
    rendered = rendered.replace("<!--HERO_VIDEO-->", heroTag);
  }

  // Background audio (Track C): download the uploaded object into `dir` as a
  // sibling file and inject an <audio> the engine muxes. AFTER the template
  // merge + watermark (so it's never substituted/escaped) and inside `dir` so
  // the engine serves it for the ffmpeg mix. Best-effort → silent on failure.
  if (options.backgroundAudio?.objectPath) {
    const tag = await resolveBackgroundAudioTag(
      project.userId,
      options.backgroundAudio,
      dir,
      rendered,
    );
    if (tag) rendered = injectBeforeBodyEnd(rendered, tag);
  }

  // Voiceover (talking-host narration): local voice.mp3 sibling, else the GCS
  // copy. NOT wrapped in a try/catch — a missing voiceover must FAIL the render
  // (VoiceoverUnavailableError), never ship a mute talking-host video.
  if (options.voiceover) {
    const tag = await resolveVoiceoverTag(
      project.userId,
      options.voiceover,
      dir,
      rendered,
    );
    rendered = injectBeforeBodyEnd(rendered, tag);
  }

  // Captions (Track E): an overlay whose opacity tweens append to the root
  // timeline. After the composition's own script (so the root timeline exists).
  if (options.captions?.words?.length) {
    const overlay = buildCaptionOverlay(
      options.captions.words,
      options.captions.style,
    );
    if (overlay) rendered = injectBeforeBodyEnd(rendered, overlay);
  }

  // Scene transitions (M8): the inlined HyperShader library + bootstrap, LAST
  // so the composition's root timeline and every scene element already exist.
  // buildTransitionsInjection returns "" for unsupported compositions (then
  // the handshake var above made the composition fall back to its hard cut
  // via __sorrelWireHardCuts — wired by the bootstrap's guard paths).
  if (transitionsActive && options.transitions) {
    const injection = buildTransitionsInjection(rendered, options.transitions);
    if (injection) rendered = injectBeforeBodyEnd(rendered, injection);
  }

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
        brandKitId: projectsTable.brandKitId,
        renderSettings: projectsTable.renderSettings,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project)
      throw new Error(`Project ${projectId} disappeared mid-render`);

    // Resolve the per-project settings (null → DEFAULT_RENDER_SETTINGS) and map
    // them to the engine's RenderConfig. The Free/Pro gate already ran at the
    // route layer; here we just honor the persisted, validated config. Resolved
    // BEFORE the composition is materialized because `watermark` decides whether
    // the badge is burned into the per-project composition.html.
    const settings = resolveSettings(project.renderSettings);

    // Burn the watermark into composition.html when settings say so (always for
    // Free — the monetization lever; removable on Pro).
    const { dir, file } = await prepareCompositionFor(project, {
      watermark: settings.watermark,
      backgroundAudio: settings.backgroundAudio,
      captions: settings.captions,
      voiceover: settings.voiceover,
      transitions: settings.transitions,
    });

    const format = settings.format;
    // Format drives the artifact path: mp4 → output.mp4 (unchanged default),
    // webm/mov → output.<ext> (file), png-sequence → frames/ (directory).
    const outputPath = outputPathFor(outputDir, format);
    const config = toEngineConfig(settings, file);
    // Also pass compositionVars as NATIVE engine variables: Hyperframes injects
    // them as window.__hfVariables and merges them over a composition's declared
    // `data-composition-variables` defaults (typed: string|number|color|boolean|
    // enum). Inert for the current {{key}}-substituted compositions (which don't
    // declare typed variables), additive for typed / __timelines compositions —
    // this enables the native typed-variable path (M3) without changing the
    // verified default render.
    if (project.compositionVars) {
      config.variables = project.compositionVars;
    }

    const job = createRenderJob(config);

    // Cancellation: the cancel route flags `render_jobs.cancelRequested`; the
    // engine only stops if it's handed an AbortSignal. Each progress tick polls
    // the flag and aborts the controller, which makes executeRenderJob throw a
    // RenderCancelledError (caught below → rollback to draft + markCancelled).
    const abortController = new AbortController();

    await executeRenderJob(
      job,
      dir,
      outputPath,
      (j, msg) => {
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
          if (!abortController.signal.aborted) {
            void isCancelRequested(renderJobId)
              .then((cancel) => {
                if (cancel && !abortController.signal.aborted) {
                  logger.info(
                    { projectId, renderJobId },
                    "Cancel requested — aborting render",
                  );
                  abortController.abort();
                }
              })
              .catch((err) =>
                logger.warn(
                  { renderJobId, err },
                  "Could not check cancel flag",
                ),
              );
          }
        }
      },
      abortController.signal,
    );

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

    // REFUND the Free-quota render: it was charged at claim time but produced no
    // output, so a failure must not permanently burn the user's monthly render.
    // (A cancellation is handled above and intentionally does NOT refund.) The
    // owning userId comes from the ledger row, which exists before this executor
    // runs. Best-effort: a refund failure must not mask the render failure, and
    // it's a harmless no-op for Pro (never charged) or a rolled-over month.
    if (renderJobId) {
      try {
        const job = await getJobById(renderJobId);
        if (job) await decrementRenderCount(job.userId);
      } catch (refundErr) {
        logger.warn(
          { projectId, renderJobId, err: refundErr },
          "Could not refund render quota after failure",
        );
      }
    }
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
