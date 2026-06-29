/**
 * Smart Trim FFmpeg engine — the one place api-server re-encodes an EXISTING
 * uploaded video (the rest of the render pipeline only rasterizes HTML
 * compositions via @hyperframes/producer; FFmpeg is otherwise touched only for
 * thumbnails). Given the EDL keep-segments from `smartTrimEdl`, it cuts the
 * source, concatenates the survivors with short audio fades at every join (no
 * pops), optionally burns word-timed captions, and writes a tightened mp4.
 *
 * Three pieces:
 *  - `extractAudio`  — pull a small mono 16 kHz track for transcription.
 *  - `buildAssSubtitles` — pure: word timings → an ASS subtitle document
 *    (2-word UPPERCASE chunks, brand-accent outline). Unit-tested without FFmpeg.
 *  - `trimVideo`     — the cut + concat + fade (+optional caption burn) render.
 *
 * ffmpeg is on PATH (it's the producer's encoder — same assumption as
 * thumbnailService). All spawns are abortable: an aborted signal kills the child
 * and surfaces `VideoTrimAbortedError`, which the render branch maps to a
 * cancellation (rollback to draft), exactly like the engine's RenderCancelledError.
 */
import fs from "fs";
import path from "path";
import { spawn } from "node:child_process";
import { logger } from "../lib/logger";
import { totalKeptDuration, type Segment } from "../lib/smartTrimEdl";

/** The project `module` string for transcript-driven footage trims. */
export const SMART_TRIM_MODULE = "smart-trim";

/**
 * The render-input contract for a smart-trim project: the source object to
 * re-fetch + the keep-EDL. Stored base64 in `compositionVars["smarttrim.payload"]`
 * (base64 survives the {{key}} substitution byte-identical) by smartTrimService
 * and decoded by the executeRender smart-trim branch. Lives here (a leaf module
 * both sides already import) to avoid a renderService↔smartTrimService cycle.
 */
export interface SmartTrimPayload {
  source: string;
  segments: Segment[];
}

export function encodeSmartTrimPayload(payload: SmartTrimPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

export function decodeSmartTrimPayload(b64: string): SmartTrimPayload | null {
  try {
    const obj = JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const o = obj as { source?: unknown; segments?: unknown };
    if (typeof o.source !== "string" || !o.source.startsWith("/objects/")) {
      return null;
    }
    if (!Array.isArray(o.segments)) return null;
    const segments = o.segments
      .map((s) => s as { start?: unknown; end?: unknown })
      .filter(
        (s) =>
          typeof s.start === "number" &&
          typeof s.end === "number" &&
          Number.isFinite(s.start) &&
          Number.isFinite(s.end) &&
          (s.end as number) > (s.start as number),
      )
      .map((s) => ({ start: s.start as number, end: s.end as number }));
    if (segments.length === 0) return null;
    return { source: o.source, segments };
  } catch {
    return null;
  }
}

/** A caption word on the TRIMMED timeline (RenderCaptionWord-shaped). */
export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

/** ffmpeg exited non-zero (not due to an abort). Carries a stderr tail for ops. */
export class VideoTrimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoTrimError";
  }
}

/** The trim was cancelled via the AbortSignal (→ render rollback to draft). */
export class VideoTrimAbortedError extends Error {
  constructor() {
    super("Video trim aborted");
    this.name = "VideoTrimAbortedError";
  }
}

/** 30ms fade at each cut — long enough to kill a click, short enough to be invisible. */
const FADE_SEC = 0.03;

/**
 * drawtext needs a font. Prefer a known TTF on the render box (Debian ships
 * DejaVu/Liberation for Chromium), else fall back to the fontconfig `sans`
 * family. Linux paths have no `:` so no filter-escaping is needed.
 */
const WATERMARK_FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
];

function resolveWatermarkFontArg(): string {
  for (const p of WATERMARK_FONT_CANDIDATES) {
    if (fs.existsSync(p)) return `fontfile=${p}`;
  }
  return "font=sans";
}

/**
 * Run ffmpeg with the given args, abortable. Resolves on exit 0; rejects with
 * `VideoTrimAbortedError` when the signal fired, else `VideoTrimError` with the
 * tail of stderr (ffmpeg writes diagnostics there). `cwd` lets callers reference
 * sidecar files (the .ass subtitle) by basename, sidestepping the `subtitles`
 * filter's platform-specific path escaping.
 */
function runFfmpeg(
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new VideoTrimAbortedError());
      return;
    }
    const child = spawn("ffmpeg", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new VideoTrimError(`ffmpeg failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) {
        reject(new VideoTrimAbortedError());
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new VideoTrimError(
          `ffmpeg exited ${code}: ${stderr.slice(-1500).trim()}`,
        ),
      );
    });
  });
}

/**
 * Extract a small mono 16 kHz AAC track from a source video for transcription.
 * Mono/16k/64k keeps even a long clip well under Whisper's 25 MB cap
 * (~0.5 MB/min → ~50 min of headroom). Returns the path + a content type the
 * transcription service can hand to the ASR endpoint.
 */
export async function extractAudio(
  sourcePath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<{ path: string; contentType: string }> {
  await runFfmpeg(
    [
      "-y",
      "-i",
      sourcePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      outPath,
    ],
    { signal },
  );
  return { path: outPath, contentType: "audio/mp4" };
}

// ─────────────────────────────── ASS captions ───────────────────────────────

/** #RRGGBB → ASS &HAABBGGRR (BGR, alpha 00 = opaque). Falls back to white. */
function hexToAssColor(hex: string | undefined): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? "").trim());
  if (!m) return "&H00FFFFFF";
  const rr = m[1].slice(0, 2);
  const gg = m[1].slice(2, 4);
  const bb = m[1].slice(4, 6);
  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

/** Seconds → ASS timestamp h:mm:ss.cc (centiseconds). */
function secToAss(t: number): string {
  const total = Math.max(0, t);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.round((total - Math.floor(total)) * 100);
  // Carry a rounded-up centisecond (e.g. 0.999 → 1.00s).
  const cc = cs === 100 ? 0 : cs;
  const ss = cs === 100 ? s + 1 : s;
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(ss)}.${pad(cc)}`;
}

/** Strip ASS-significant chars from user text (braces = override blocks; newlines). */
function sanitizeAssText(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/[\r\n]+/g, " ").trim();
}

export interface AssOptions {
  /** Brand accent (#RRGGBB) used for the caption outline. Default lime. */
  accentColor?: string;
  /** Words per on-screen chunk (video-use uses 2). Default 2. */
  wordsPerChunk?: number;
}

/**
 * Build an ASS subtitle document from trimmed-timeline caption words: UPPERCASE,
 * `wordsPerChunk`-word chunks, bottom-center, bold white with a brand-accent
 * outline. Pure (no FFmpeg) so it unit-tests as a string. Resolution-independent:
 * Alignment 2 (bottom-center) + a viewport-relative PlayRes let libass scale it
 * to portrait / landscape / square alike.
 */
export function buildAssSubtitles(
  words: readonly CaptionWord[],
  opts: AssOptions = {},
): string {
  const accent = hexToAssColor(opts.accentColor);
  const perChunk = Math.max(1, Math.floor(opts.wordsPerChunk ?? 2));
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // White text, brand-accent outline, heavy weight, bottom-center, 7% bottom margin.
    `Style: Sorrel,Arial,72,&H00FFFFFF,&H000000FF,${accent},&H64000000,-1,0,0,0,100,100,0,0,1,4,2,2,80,80,80,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const clean = [...words]
    .filter((w) => w && w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += perChunk) {
    const chunk = clean.slice(i, i + perChunk);
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    const text = sanitizeAssText(chunk.map((w) => w.text).join(" ")).toUpperCase();
    if (!text) continue;
    lines.push(
      `Dialogue: 0,${secToAss(start)},${secToAss(end)},Sorrel,,0,0,0,,${text}`,
    );
  }

  return `${header.join("\n")}\n${lines.join("\n")}\n`;
}

// ─────────────────────────────── trim render ────────────────────────────────

export interface TrimVideoOptions {
  /** Absolute path to the downloaded source video. */
  sourcePath: string;
  /** Keep-segments (SOURCE seconds) from `computeKeepSegments`. Non-empty. */
  segments: readonly Segment[];
  /** Absolute path to write the trimmed mp4. */
  outputPath: string;
  /** Scratch dir for the .ass sidecar; ffmpeg runs with this cwd. */
  workDir: string;
  /** Caption words (trimmed timeline) to burn. Omit → no captions. */
  captions?: readonly CaptionWord[];
  /** Brand accent (#RRGGBB) for the caption outline. */
  brandColor?: string;
  /** Burn the "Made with Sorrel" watermark (Free tier). Default false. */
  watermark?: boolean;
  signal?: AbortSignal;
}

/** Format a second value for a filter literal (3dp, never exponential). */
function ff(n: number): string {
  return n.toFixed(3);
}

/**
 * Cut the source to the keep-segments and concatenate them into one mp4, with a
 * 30 ms audio fade at every join and (optionally) burned captions. Single
 * ffmpeg pass: per-segment `trim`/`atrim` + `afade`, then `concat`, then an
 * optional `subtitles` burn. Re-encodes (libx264/aac, yuv420p, faststart) so the
 * output is uniformly seekable regardless of the source codec.
 *
 * Returns the output path and the trimmed duration (sum of kept spans).
 */
export async function trimVideo(
  opts: TrimVideoOptions,
): Promise<{ outputPath: string; duration: number }> {
  const { sourcePath, segments, outputPath, workDir, signal } = opts;
  if (segments.length === 0) {
    throw new VideoTrimError("No segments to trim");
  }
  fs.mkdirSync(workDir, { recursive: true });

  const parts: string[] = [];
  const concatInputs: string[] = [];
  segments.forEach((seg, i) => {
    const s = ff(seg.start);
    const e = ff(seg.end);
    const fadeOutStart = ff(Math.max(0, seg.end - seg.start - FADE_SEC));
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(
      `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${ff(FADE_SEC)},afade=t=out:st=${fadeOutStart}:d=${ff(FADE_SEC)}[a${i}]`,
    );
    concatInputs.push(`[v${i}][a${i}]`);
  });
  parts.push(
    `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[vcat][aout]`,
  );

  // Apply the optional video overlays in order: captions, then watermark. Each
  // stage consumes the current label and emits a new one; with neither, the
  // mapped label stays the concat output [vcat].
  let videoLabel = "[vcat]";

  // Burn captions by writing the .ass next to the work dir and referencing it by
  // basename (ffmpeg cwd = workDir), avoiding `subtitles=` path-escaping on Windows.
  if (opts.captions && opts.captions.length > 0) {
    const assName = "captions.ass";
    fs.writeFileSync(
      path.join(workDir, assName),
      buildAssSubtitles(opts.captions, { accentColor: opts.brandColor }),
      "utf-8",
    );
    parts.push(`${videoLabel}subtitles=${assName}[vcap]`);
    videoLabel = "[vcap]";
  }

  // "Made with Sorrel" watermark — the Free-tier monetization lever, removable on
  // Pro (mirrors the composition path's injectWatermark, but burned via drawtext
  // since smart-trim never enters the HTML pipeline). Fixed text → no escaping.
  if (opts.watermark) {
    const fontArg = resolveWatermarkFontArg();
    parts.push(
      `${videoLabel}drawtext=${fontArg}:text='Made with Sorrel':` +
        `fontcolor=white@0.92:fontsize=h/26:box=1:boxcolor=black@0.42:boxborderw=12:` +
        `x=w-tw-28:y=h-th-28[vwm]`,
    );
    videoLabel = "[vwm]";
  }

  const filterComplex = parts.join(";");
  const args = [
    "-y",
    "-i",
    sourcePath,
    "-filter_complex",
    filterComplex,
    "-map",
    videoLabel,
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  logger.info(
    { sourcePath, outputPath, segments: segments.length, captions: opts.captions?.length ?? 0 },
    "Smart Trim render starting",
  );
  await runFfmpeg(args, { cwd: workDir, signal });

  return { outputPath, duration: totalKeptDuration(segments) };
}
