#!/usr/bin/env node
// @ts-check
/**
 * Self-host every platform template's gallery thumbnail. For each vendored
 * registry composition this renders the composition with the installed 0.6.6
 * producer, grabs a representative poster frame, and writes a COMMITTED PNG to
 * src/compositions/thumbnails/<slug>.png — replacing the dependency on HeyGen's
 * `static.heygen.ai` CDN (which the importer recorded as `thumbnailUrl`).
 *
 *     pnpm --filter @workspace/api-server exec node scripts/generate-thumbnails.mjs
 *
 * The api-server serves these at GET /api/templates/thumbnails/<slug>.png (a
 * static route in app.ts), and the importer rewrites the manifest's
 * thumbnailUrl to that served path (the original CDN URL is preserved as a
 * documented fallback in `cdnThumbnailUrl`). seedPlatformTemplates already
 * persists whatever thumbnailUrl the manifest carries, so no other glue is
 * needed.
 *
 * WHY render-then-seek (not frame 0):
 *   These compositions fade / slide / zoom in, so frame 0 is frequently blank.
 *   We render the whole clip to a throwaway mp4, then seek to ~40 % of its
 *   duration (`-ss`) and extract a single frame — past the intro animation,
 *   into the composition's "hero" state. The mp4 is H.264 (yuv420p, opaque), so
 *   any transparent composition is already flattened by the encoder; we ALSO
 *   composite the extracted frame onto a neutral dark canvas as a belt-and-
 *   braces guard so alpha edges / letterboxing never read as pure black.
 *
 * Network is NOT needed (unlike the importer) — this only drives the local
 * render engine + ffmpeg. Output is committed, so dev/CI/prod never regenerate.
 *
 * Exit 0 only if EVERY composition produced a non-trivial PNG; prints a per-slug
 * table + a FAIL list otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CWD = process.cwd(); // artifacts/api-server when run via pnpm exec
const COMPOSITIONS_DIR = path.join(CWD, "src", "compositions");
const THUMBNAILS_DIR = path.join(COMPOSITIONS_DIR, "thumbnails");
const MANIFEST = path.join(COMPOSITIONS_DIR, "registry-templates.generated.json");
const CORE_SRC = path.join(CWD, "node_modules", "@hyperframes", "core", "dist");
const CORE_DEST = path.join(CWD, "core", "dist");
const WORK = path.join(CWD, "renders", "__thumbnails__");

// Render knobs: a poster frame is a single still, so fidelity comes from the
// composition, not the framerate. A modest fps keeps the full batch fast while
// still landing real frames at the candidate seek marks. `draft` matches the
// verify script (this is a smoke-quality still, not a deliverable).
const FPS = 12;
// Candidate seek fractions of the clip's duration. These compositions all
// animate IN (fade / slide / type / zoom / country-by-country choropleth
// reveal), so an early frame is often blank or half-drawn. We grab one frame at
// each fraction — biased to the back half where the composition has settled
// into its "hero" state — and keep whichever has the most visual content (see
// `pickBestFrame`). Starting at 40 % follows the brief's "~40 %" guidance as the
// EARLIEST candidate, while a slow reveal (world-map fully paints only by ~90 %)
// is still captured.
const SEEK_FRACTIONS = [0.4, 0.55, 0.7, 0.85, 0.95];
const MAX_EDGE = 1280; // longest output edge in px — sharp but compact
const BG = "0x0b1020"; // neutral dark flatten background (ffmpeg color= syntax)
// A correct poster of a 1280-edge composition is tens of KB; anything at or
// under this is almost certainly a blank/near-blank frame we should fail on.
const MIN_BYTES = 3000;

// A distinctive sample brand so any injected {{brand.*}} placeholders RESOLVE
// in the poster (vs rendering literal braces). Mirrors verify-registry-renders'
// SAMPLE_VARS / renderService's STUDIO_FALLBACKS shape; unknown keys → "".
const SAMPLE_VARS = {
  "brand.companyName": "SORREL DEMO",
  "brand.initial": "S",
  "brand.primaryColor": "#ff3366",
  "brand.secondaryColor": "#3366ff",
  "brand.accentColor": "#ffcc00",
  "brand.fontFamily": "'Inter'",
  "brand.logoUrl": "",
  "user.headline": "Sorrel render check",
  "user.bodyText": "Placeholder substitution verified.",
  "user.ctaText": "Ship it",
  duration: "9",
  // Aspect-responsive compositions read {{layout.*}} (see buildCompositionHtml);
  // posters are generated at the authored portrait canvas.
  "layout.width": "1080",
  "layout.height": "1920",
  "layout.aspect": "portrait",
};

/** @param {string} html */
function substitute(html) {
  return html.replace(/{{\s*([a-zA-Z0-9._-]+)\s*}}/g, (_m, k) =>
    SAMPLE_VARS[k] !== undefined ? SAMPLE_VARS[k] : "",
  );
}

/**
 * Run ffmpeg with the given args; resolve true on exit code 0, false otherwise
 * (spawn error or non-zero). Mirrors thumbnailService's defensive ffmpeg use.
 * @param {string[]} args
 * @returns {Promise<boolean>}
 */
function ffmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Seek to `seekSeconds` and write a single raw frame. `-ss` BEFORE `-i` is the
 * fast input-seek; `-frames:v 1` writes exactly one frame.
 * @param {string} mp4Path
 * @param {number} seekSeconds
 * @param {string} rawPng
 * @returns {Promise<number>} byte size of the written frame (0 on failure)
 */
async function grabFrame(mp4Path, seekSeconds, rawPng) {
  const ok = await ffmpeg([
    "-v",
    "error",
    "-y",
    "-ss",
    seekSeconds.toFixed(3),
    "-i",
    mp4Path,
    "-frames:v",
    "1",
    rawPng,
  ]);
  return ok && fs.existsSync(rawPng) ? fs.statSync(rawPng).size : 0;
}

/**
 * Pick the most visually-loaded frame. We grab a candidate at each
 * SEEK_FRACTION and keep the one whose encoded PNG is LARGEST: a blank /
 * half-faded frame is a near-flat image that PNG compresses to a few KB, while a
 * fully-revealed composition (text, chart bars, a painted choropleth) is rich
 * and compresses far larger. This is what makes the slow-revealing world-map
 * (near-blank at 40 %, fully painted by ~90 %) resolve to a real poster without
 * any per-slug seek tuning.
 * @param {string} mp4Path
 * @param {number} durationS
 * @param {string} scratchBase  path prefix for the throwaway candidate frames
 * @returns {Promise<string | null>} path to the winning raw frame, or null
 */
async function pickBestFrame(mp4Path, durationS, scratchBase) {
  let best = null;
  let bestSize = 0;
  const losers = [];
  for (const frac of SEEK_FRACTIONS) {
    const seek = Math.max(0, durationS * frac);
    const candidate = `${scratchBase}.${Math.round(frac * 100)}.png`;
    const size = await grabFrame(mp4Path, seek, candidate);
    if (size > bestSize) {
      if (best) losers.push(best);
      best = candidate;
      bestSize = size;
    } else if (size > 0) {
      losers.push(candidate);
    }
  }
  for (const l of losers) fs.rmSync(l, { force: true });
  return best;
}

/**
 * Composite a STATIC frame over a dark canvas + downscale into the final poster.
 * Flattening a still image (not a live `-ss` stream) sidesteps the PTS mismatch
 * that makes a single-pass `lavfi color` + seeked-video overlay drop the frame
 * entirely (the color source starts at t=0, a seeked frame's PTS is far ahead,
 * so overlay never finds a matching background frame → blank PNG).
 *
 * The frame is scaled to fit inside a MAX_EDGE box (aspect preserved); a dark
 * background is then sized to EXACTLY the scaled frame via `scale2ref` and the
 * frame is overlaid onto it. Sizing the bg to the frame (not a fixed square)
 * keeps the composition's own aspect ratio — no letterbox bars — while the dark
 * canvas only shows through genuine transparency. `format=rgb24` drops any alpha
 * so the committed PNG is a flat, opaque poster.
 * @param {string} rawPng
 * @param {string} outPng
 * @returns {Promise<boolean>}
 */
async function flattenToPoster(rawPng, outPng) {
  const ok = await ffmpeg([
    "-v",
    "error",
    "-y",
    "-i",
    rawPng,
    "-filter_complex",
    `color=c=${BG}:s=${MAX_EDGE}x${MAX_EDGE}[bg];` +
      `[0:v]scale=${MAX_EDGE}:${MAX_EDGE}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]scale2ref[bg2][fg2];` +
      `[bg2][fg2]overlay=0:0:format=auto,format=rgb24`,
    "-frames:v",
    "1",
    outPng,
  ]);
  return ok && fs.existsSync(outPng);
}

async function main() {
  if (!fs.existsSync(COMPOSITIONS_DIR)) {
    console.error(`[thumbnails] compositions dir not found: ${COMPOSITIONS_DIR}`);
    process.exit(1);
  }
  // The producer reads its core runtime from <cwd>/core/dist (see CLAUDE.md).
  if (!fs.existsSync(CORE_DEST)) {
    if (!fs.existsSync(CORE_SRC)) {
      console.error("[thumbnails] no core/dist (run from artifacts/api-server)");
      process.exit(1);
    }
    fs.cpSync(CORE_SRC, CORE_DEST, { recursive: true, dereference: true });
  }

  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));

  // Hand-authored showcase templates (Track B) live alongside the vendored
  // registry blocks but aren't in the manifest. They render through the exact
  // same path, so just append them to the batch. Keep `slug`/`duration` in sync
  // with HAND_AUTHORED_TEMPLATES in services/platformTemplatesService.ts.
  const HAND_AUTHORED = [
    { slug: "product-3d", duration: 7 },
    { slug: "lottie-reveal", duration: 6 },
    { slug: "video-spotlight", duration: 9 },
  ];

  // Optional CLI filter: `node scripts/generate-thumbnails.mjs <slug> [<slug>…]`
  // regenerates only the named templates (e.g. after adding one) instead of the
  // whole batch. No args → every template.
  const only = process.argv.slice(2);
  const templates = [...manifest, ...HAND_AUTHORED].filter(
    (t) => only.length === 0 || only.includes(t.slug),
  );

  const { createRenderJob, executeRenderJob } = await import(
    "@hyperframes/producer"
  );

  const results = [];
  for (const t of templates) {
    const compFile = path.join(COMPOSITIONS_DIR, `${t.slug}.html`);
    const dir = path.join(WORK, t.slug);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "composition.html"),
      substitute(fs.readFileSync(compFile, "utf-8")),
      "utf-8",
    );
    const mp4 = path.join(dir, "out.mp4");
    const outPng = path.join(THUMBNAILS_DIR, `${t.slug}.png`);
    try {
      const job = createRenderJob({
        fps: { num: FPS, den: 1 },
        quality: "draft",
        format: "mp4",
        entryFile: "composition.html",
      });
      await executeRenderJob(job, dir, mp4, () => {});
      // Prefer the engine-probed duration; fall back to the manifest's authored
      // seconds (clamped to >= 1s so the seek fractions stay sane).
      const durationS =
        typeof job.duration === "number" && job.duration > 0
          ? job.duration
          : Math.max(1, Number(t.duration) || 4);
      const best = await pickBestFrame(mp4, durationS, path.join(dir, "frame"));
      const ok = best ? await flattenToPoster(best, outPng) : false;
      const size = ok && fs.existsSync(outPng) ? fs.statSync(outPng).size : 0;
      const pass = size >= MIN_BYTES;
      results.push({ slug: t.slug, ok: pass, kib: (size / 1024).toFixed(0) });
      console.log(
        `[thumbnails] ${pass ? "✓" : "✗"} ${t.slug.padEnd(34)} ${(
          size / 1024
        ).toFixed(0)} KiB  dur=${durationS.toFixed(0)}s`,
      );
    } catch (err) {
      results.push({
        slug: t.slug,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(
        `[thumbnails] ✗ ${t.slug.padEnd(34)} THREW: ${
          err instanceof Error ? err.message.split("\n")[0] : err
        }`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n[thumbnails] ${results.length - failed.length}/${results.length} thumbnails written to ${THUMBNAILS_DIR}`,
  );
  if (failed.length) {
    console.log("[thumbnails] FAILED:");
    for (const f of failed)
      console.log(`  - ${f.slug}${f.error ? `: ${f.error.split("\n")[0]}` : ""}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(
    `[thumbnails] FAILED: ${err instanceof Error ? err.stack : err}`,
  );
  process.exit(1);
});
