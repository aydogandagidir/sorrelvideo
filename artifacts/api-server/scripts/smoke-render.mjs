#!/usr/bin/env node
// @ts-check
/**
 * Render smoke-test — proves the real Hyperframes producer can rasterize a
 * Sorrel composition to a non-empty MP4 on this machine.
 *
 * This is the permanent, repeatable version of the throwaway script we ran by
 * hand to verify the render pipeline (closes a deferred M0 item). Run it via:
 *
 *     pnpm --filter @workspace/api-server run smoke:render
 *
 * It is intentionally standalone (plain ESM, no TypeScript, no DB, no Express):
 * it exercises ONLY the render half of the pipeline — Chrome (BeginFrame) +
 * FFmpeg via `@hyperframes/producer` — so a green run means the engine, its
 * core runtime, Chromium, and FFmpeg are all wired up correctly here / in CI.
 *
 * Exit codes:
 *   0  render produced a non-empty MP4
 *   1  any failure (producer unresolvable, render threw, zero-byte output, …)
 *
 * IMPORTANT — working directory:
 *   When launched via the pnpm script above, cwd is `artifacts/api-server`.
 *   The producer loads its core runtime from `<cwd>/core/dist` at render time,
 *   so every path below is resolved against `process.cwd()` and the script
 *   materializes `./core/dist` from node_modules if it is missing. Running it
 *   from any other directory will look for `core/dist` in the wrong place.
 */

import path from "node:path";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

// --- Resolve everything relative to the api-server cwd ------------------------
// (process.cwd() === artifacts/api-server when run via the pnpm filter script).
const CWD = process.cwd();

/** node_modules copy of the core runtime the producer expects at <cwd>/core/dist. */
const CORE_DIST_SRC = path.join(
  CWD,
  "node_modules",
  "@hyperframes",
  "core",
  "dist",
);
/** Where the producer actually reads the core runtime from at render time. */
const CORE_DIST_DEST = path.join(CWD, "core", "dist");

/** Composition we render. studio-default is the Studio template (1080x1920). */
const COMPOSITION_SRC = path.join(
  CWD,
  "src",
  "compositions",
  "studio-default.html",
);

/** Throwaway workspace for this run. Under renders/ so it's already gitignored. */
const SMOKE_DIR = path.join(CWD, "renders", "__smoke__");
const ENTRY_FILE = "composition.html"; // relative to SMOKE_DIR (the projectDir)
const OUTPUT_PATH = path.join(SMOKE_DIR, "output.mp4");

/**
 * Sample values for the `{{ key }}` placeholders in the composition. Mirrors
 * the production STUDIO_FALLBACKS (renderService.ts) closely enough to produce
 * a sensible frame; the exact strings don't matter for a smoke-test, only that
 * NO raw `{{...}}` braces survive into the HTML Chrome rasterizes.
 */
const SAMPLE_VARS = {
  "brand.companyName": "Sorrel Smoke Test",
  "brand.initial": "S",
  "brand.primaryColor": "#6366f1",
  "brand.secondaryColor": "#1e293b",
  "brand.accentColor": "#f59e0b",
  "brand.fontFamily": "'Inter'",
  "brand.logoUrl": "",
  "user.headline": "Render pipeline\nis alive.",
  "user.bodyText":
    "If you can read this in an mp4, Chrome + FFmpeg + the Hyperframes producer all work on this machine.",
  "user.ctaText": "Ship it",
};

/** Fail fast with a clear, prefixed message and a non-zero exit code. */
function fail(message) {
  console.error(`\n[smoke:render] FAIL: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[smoke:render] ${message}`);
}

/**
 * Ensure `<cwd>/core/dist` exists. The producer reads its core runtime from
 * there at render time but the directory is a build artifact (gitignored, not
 * source), so on a fresh checkout / CI it won't exist yet — materialize it from
 * the node_modules copy. Prints whether it copied or found an existing dir.
 */
function ensureCoreDist() {
  if (fs.existsSync(CORE_DIST_DEST)) {
    log(`core/dist already present at ${CORE_DIST_DEST} (reusing).`);
    return;
  }
  if (!fs.existsSync(CORE_DIST_SRC)) {
    fail(
      `core runtime not found at ${CORE_DIST_SRC}. ` +
        `Is @hyperframes/core installed? Run pnpm install from the repo root.`,
    );
  }
  log(`core/dist missing — copying from ${CORE_DIST_SRC} ...`);
  // dereference: true follows symlinks so the materialized copy is self-contained
  // (pnpm's node_modules layout is symlink-heavy) and survives outside the store.
  fs.cpSync(CORE_DIST_SRC, CORE_DIST_DEST, {
    recursive: true,
    dereference: true,
  });
  log(`core/dist materialized at ${CORE_DIST_DEST}.`);
}

/**
 * Replace every `{{ key }}` placeholder in the composition with a sample value.
 * Known keys map to SAMPLE_VARS; any unknown placeholder collapses to "" so no
 * raw braces can survive (an unsubstituted `{{x}}` would render as literal text
 * and is exactly the kind of regression this smoke-test should catch).
 */
function substitutePlaceholders(source) {
  return source.replace(/{{\s*([a-zA-Z0-9._-]+)\s*}}/g, (_match, key) => {
    const value = SAMPLE_VARS[key];
    return value === undefined ? "" : value;
  });
}

async function main() {
  const startedAt = performance.now();

  log(`cwd = ${CWD}`);

  // 1. Make sure the producer can be resolved before we do any work.
  if (
    !fs.existsSync(
      path.join(CWD, "node_modules", "@hyperframes", "producer"),
    )
  ) {
    fail(
      "@hyperframes/producer is not installed under api-server's node_modules. " +
        "Run pnpm install from the repo root.",
    );
  }

  // 2. Ensure the core runtime the producer loads at render time exists.
  ensureCoreDist();

  // 3. Read the composition and substitute every placeholder.
  if (!fs.existsSync(COMPOSITION_SRC)) {
    fail(`composition not found at ${COMPOSITION_SRC}`);
  }
  const source = fs.readFileSync(COMPOSITION_SRC, "utf-8");
  const html = substitutePlaceholders(source);
  const leftover = html.match(/{{\s*[a-zA-Z0-9._-]+\s*}}/);
  if (leftover) {
    fail(
      `composition still contains an unsubstituted placeholder: ${leftover[0]}`,
    );
  }

  // 4. Write the prepared composition into a clean per-run temp dir.
  fs.rmSync(SMOKE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SMOKE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SMOKE_DIR, ENTRY_FILE), html, "utf-8");
  log(`prepared ${ENTRY_FILE} in ${SMOKE_DIR}`);

  // 5. Import the producer and build a draft-quality MP4 render job. The config
  //    mirrors the engine config the real pipeline uses (renderSettingsService
  //    toEngineConfig), at the cheapest quality so the smoke-test stays fast.
  const { createRenderJob, executeRenderJob } = await import(
    "@hyperframes/producer"
  ).catch((err) => {
    fail(`could not import @hyperframes/producer: ${err?.message ?? err}`);
    // `fail` exits, but return to satisfy the type-checker / control flow.
    return /** @type {never} */ (undefined);
  });

  const config = {
    fps: { num: 30, den: 1 },
    quality: "draft",
    format: "mp4",
    entryFile: ENTRY_FILE,
  };

  log(`starting render (quality=draft, fps=30, format=mp4) ...`);
  const job = createRenderJob(config);

  // Progress callback: print a coarse percentage so a hung render is visible.
  let lastPct = -1;
  await executeRenderJob(job, SMOKE_DIR, OUTPUT_PATH, (j, message) => {
    const pct = Math.round((j.progress ?? 0) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      log(`progress ${pct}% — ${j.currentStage ?? message ?? ""}`.trim());
    }
  });

  // 6. Assert the output exists and is non-empty.
  if (!fs.existsSync(OUTPUT_PATH)) {
    fail(`render finished but no output file at ${OUTPUT_PATH}`);
  }
  const { size } = fs.statSync(OUTPUT_PATH);
  if (size <= 0) {
    fail(`output file is zero bytes: ${OUTPUT_PATH}`);
  }

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
  const sizeKb = (size / 1024).toFixed(1);
  log(`OK — wrote ${OUTPUT_PATH}`);
  log(
    `output size = ${sizeKb} KiB | elapsed = ${elapsedSec}s | ` +
      `job.duration = ${job.duration ?? "n/a"}s`,
  );

  // 7. Clean up the throwaway render dir on success (leave it on failure so it
  //    can be inspected). core/dist is intentionally left in place — it's a
  //    reusable build artifact, regenerating it every run would be wasteful.
  fs.rmSync(SMOKE_DIR, { recursive: true, force: true });
  log("cleaned up temp render dir. Render smoke-test PASSED.");
  process.exit(0);
}

// Only auto-run when invoked directly (node scripts/smoke-render.mjs), not if
// imported. Top-level try/catch guarantees a non-zero exit on any throw.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
  });
}
