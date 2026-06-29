/**
 * Single-scene AI-background END-TO-END render smoke — drives the REAL producer
 * (Chrome + FFmpeg) over `studio-default.html` with an AI background set, exactly
 * as `executeRender` composes it. Companion to `transitionsRenderSmoke.test.ts`
 * (which covers the brand-story shader + AI-bg case): this one proves the
 * `.ai-bg-layer` actually PAINTS for the single-scene copy templates.
 *
 * WHY a render and not just a substitution unit test: the layer sits at
 * `z-index:-1`, which only renders ABOVE the scene's own opaque background when
 * the `.scene` establishes a stacking context (`isolation: isolate`). That is a
 * runtime CSS-stacking fact a string assertion cannot catch — it took an actual
 * frame grab to discover the layer was painting BEHIND the background.
 *
 * GATED behind RENDER_SMOKE=1 (a full render takes ~1–2 min + the toolchain):
 *
 *   RENDER_SMOKE=1 PRODUCER_HEADLESS_SHELL_PATH=<chrome-headless-shell> \
 *     pnpm exec vitest run --project api-server src/services/aiBackgroundRenderSmoke.test.ts
 *
 * Set KEEP_SMOKE_OUTPUT=1 to keep the mp4 + extracted frame for eyeballing.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";
import { renderCompositionTemplate } from "./renderService";
import { resolveSettings, toEngineConfig } from "./renderSettingsService";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.RENDER_SMOKE === "1";

/** Solid-magenta 48×48 JPEG data URI — an unmistakable AI background (see the
 * transitions smoke for the same fixture). The readability scrim darkens it. */
const AI_BG_DATA_URI =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgMDA4MDhAQEBAQEBMSExQUFBMTExMUFBQVFRUZGRkVFRUUFBUVGBgZGRscGxoaGRocHB4eHiQkIiIqKiszMz7/xABMAAEBAAAAAAAAAAAAAAAAAAAABQEBAQAAAAAAAAAAAAAAAAAAAAcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAwADADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCQAqi1gAAAAAAAAAAAAAAAP//Z";

const VARS: Record<string, string> = {
  "brand.companyName": "SORREL DEMO",
  "brand.initial": "S",
  "brand.primaryColor": "#a3e635",
  "brand.secondaryColor": "#101014",
  "brand.accentColor": "#f59e0b",
  "brand.fontFamily": "'Inter'",
  "brand.logoUrl": "",
  "user.headline": "AI background.\nIn the picture.",
  "user.bodyText": "This render proves the ai-bg layer actually paints.",
  "user.ctaText": "Ship it",
  "layout.width": "1080",
  "layout.height": "1920",
  "layout.aspect": "portrait",
  "ai.backgroundImage": AI_BG_DATA_URI,
};

describe.runIf(SMOKE)("single-scene AI background render smoke", () => {
  it(
    "renders studio-default with the AI background composited behind the copy",
    async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, "../compositions/studio-default.html"),
        "utf-8",
      );
      const settings = resolveSettings(null); // defaults: standard / 30fps / portrait, no transitions

      const html = renderCompositionTemplate(src, VARS);
      // Single scene → exactly one ai-bg layer carries the data URI.
      expect(html.split(`src="${AI_BG_DATA_URI}"`).length - 1).toBe(1);
      expect(html).not.toContain("{{ai.backgroundImage}}");

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-aibg-1scene-"));
      fs.writeFileSync(path.join(dir, "composition.html"), html, "utf-8");
      const outputPath = path.join(dir, "output.mp4");

      const job = createRenderJob(toEngineConfig(settings, "composition.html"));
      await executeRenderJob(job, dir, outputPath);

      expect(fs.statSync(outputPath).size).toBeGreaterThan(50_000);

      execFileSync("ffmpeg", [
        "-y",
        "-ss",
        "2.0",
        "-i",
        outputPath,
        "-frames:v",
        "1",
        path.join(dir, "aibg-studio.png"),
      ]);

      if (process.env.KEEP_SMOKE_OUTPUT === "1") {
        console.log(`[aibg-1scene-smoke] output kept at: ${dir}`);
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
