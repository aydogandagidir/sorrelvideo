#!/usr/bin/env node
// @ts-check
/**
 * Render-verify every vendored registry composition with the installed 0.6.6
 * producer — proves each adopted template actually rasterizes (no parse/runtime
 * error, non-empty output) BEFORE it is seeded into the gallery. Renders at a
 * reduced fps (crash/blank smoke, not fidelity) so the full batch finishes fast.
 *
 *     pnpm --filter @workspace/api-server exec node scripts/verify-registry-renders.mjs
 *
 * Exit 0 only if ALL compositions render to a non-empty MP4; prints a per-slug
 * table + a FAIL list so broken templates can be excluded before seeding.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = process.cwd(); // artifacts/api-server
const COMPOSITIONS_DIR = path.join(CWD, "src", "compositions");
const MANIFEST = path.join(COMPOSITIONS_DIR, "registry-templates.generated.json");
const CORE_SRC = path.join(CWD, "node_modules", "@hyperframes", "core", "dist");
const CORE_DEST = path.join(CWD, "core", "dist");
// Scratch lives under the OS temp dir, NOT in the (already deep) worktree:
// the producer mkdtemps a `work-<uuid>-XXXXXX` INSIDE the per-slug dir, and a
// long slug like `code-snippet-apple-terminal-silver-aerogel` blew past
// Windows' 260-char MAX_PATH when nested under the worktree path → ENAMETOOLONG.
// os.tmpdir() (~40 chars) keeps every path well under the limit. (Prod renders
// use `renders/<numeric-id>/`, which is short — this only ever bit the verifier.)
const WORK = path.join(os.tmpdir(), "hf-verify");
const FPS = 8; // reduced — smoke for "renders without error", not visual fidelity

// A distinctive sample brand so a glance at the output proves any injected
// {{brand.*}} placeholders actually RESOLVE (vs rendering literal braces).
// Mirrors renderService's STUDIO_FALLBACKS shape; unknown keys collapse to "".
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
};
function substitute(html) {
  return html.replace(/{{\s*([a-zA-Z0-9._-]+)\s*}}/g, (_m, k) =>
    SAMPLE_VARS[k] !== undefined ? SAMPLE_VARS[k] : "",
  );
}

if (!fs.existsSync(CORE_DEST)) {
  if (!fs.existsSync(CORE_SRC)) { console.error("[verify] no core/dist"); process.exit(1); }
  fs.cpSync(CORE_SRC, CORE_DEST, { recursive: true, dereference: true });
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
const { createRenderJob, executeRenderJob } = await import("@hyperframes/producer");

const results = [];
for (const t of manifest) {
  const file = path.join(COMPOSITIONS_DIR, `${t.slug}.html`);
  const dir = path.join(WORK, t.slug);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "composition.html"),
    substitute(fs.readFileSync(file, "utf-8")),
    "utf-8",
  );
  const out = path.join(dir, "out.mp4");
  try {
    const job = createRenderJob({ fps: { num: FPS, den: 1 }, quality: "draft", format: "mp4", entryFile: "composition.html" });
    await executeRenderJob(job, dir, out, () => {});
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    results.push({ slug: t.slug, ok: size > 0, kib: (size / 1024).toFixed(0), frames: job.totalFrames ?? "?" });
    console.log(`[verify] ${size > 0 ? "✓" : "✗"} ${t.slug.padEnd(34)} ${(size / 1024).toFixed(0)} KiB  frames=${job.totalFrames ?? "?"}`);
  } catch (err) {
    results.push({ slug: t.slug, ok: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`[verify] ✗ ${t.slug.padEnd(34)} THREW: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
  if (!process.env.KEEP_VERIFY_OUTPUT) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[verify] ${results.length - failed.length}/${results.length} rendered OK.`);
if (failed.length) {
  console.log("[verify] FAILED (exclude these before seeding):");
  for (const f of failed) console.log(`  - ${f.slug}${f.error ? `: ${f.error.split("\n")[0]}` : ""}`);
}
process.exit(failed.length ? 1 : 0);
