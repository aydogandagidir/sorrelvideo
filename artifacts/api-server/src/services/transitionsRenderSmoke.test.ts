/**
 * Shader-transitions END-TO-END render smoke (M8) — drives the REAL producer
 * (Chrome + FFmpeg) over the brand-story composition with a transition
 * configured, exactly as `executeRender` composes it (template substitution →
 * transitions injection → toEngineConfig → createRenderJob/executeRenderJob).
 *
 * GATED behind RENDER_SMOKE=1 (NOT part of the normal suite/CI — a full render
 * takes 1–3 minutes and needs the render toolchain):
 *
 *   RENDER_SMOKE=1 PRODUCER_HEADLESS_SHELL_PATH=<chrome-headless-shell> \
 *     pnpm vitest run --project api-server src/services/transitionsRenderSmoke.test.ts
 *
 * Set KEEP_SMOKE_OUTPUT=1 to keep the output dir (mp4 + extracted boundary
 * frames) for eyeballing the shader blend.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";
import {
  buildTransitionsInjection,
  renderCompositionTemplate,
} from "./renderService";
import { resolveSettings, toEngineConfig } from "./renderSettingsService";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SMOKE = process.env.RENDER_SMOKE === "1";

/** The render-path var set for a branded brand-story with transitions ON. */
const SMOKE_VARS: Record<string, string> = {
  "brand.companyName": "SORREL DEMO",
  "brand.initial": "S",
  "brand.primaryColor": "#a3e635",
  "brand.secondaryColor": "#101014",
  "brand.accentColor": "#f59e0b",
  "brand.fontFamily": "'Inter'",
  "brand.logoUrl": "",
  "user.headline": "Two scenes.\nOne real transition.",
  "user.bodyText": "This render proves the shader actually composites.",
  "user.ctaText": "Ship it",
  "layout.width": "1080",
  "layout.height": "1920",
  "layout.aspect": "portrait",
  "sorrel.transitionsActive": "1",
};

describe.runIf(SMOKE)("brand-story shader transition render smoke", () => {
  it(
    "renders to a playable mp4 with the HyperShader bootstrap injected",
    async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, "../compositions/brand-story.html"),
        "utf-8",
      );
      const settings = resolveSettings({
        transitions: [
          { time: 4, shader: "whip-pan", duration: 0.6, ease: "power2.inOut" },
        ],
      });
      expect(settings.transitions).toHaveLength(1);

      let html = renderCompositionTemplate(src, SMOKE_VARS);
      expect(html).toContain('TRANSITIONS_ACTIVE = "1" === "1"');

      const injection = buildTransitionsInjection(
        html,
        settings.transitions ?? [],
      );
      expect(injection).toContain("window.HyperShader.init");
      const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
      html = html.slice(0, bodyEnd) + injection + html.slice(bodyEnd);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-m8-smoke-"));
      fs.writeFileSync(path.join(dir, "composition.html"), html, "utf-8");
      const outputPath = path.join(dir, "output.mp4");

      const job = createRenderJob(toEngineConfig(settings, "composition.html"));
      await executeRenderJob(job, dir, outputPath);

      const stat = fs.statSync(outputPath);
      expect(stat.size).toBeGreaterThan(50_000);

      // ffprobe: duration ≈ the composition's authored 8s.
      const probed = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          outputPath,
        ],
        { encoding: "utf-8" },
      ).trim();
      expect(Math.abs(parseFloat(probed) - 8)).toBeLessThan(0.5);

      // Extract frames straddling the boundary (4s) + scene references for the
      // human eyeball pass: a working shader shows a BLEND at 4.0s, distinct
      // from both pure scenes; a broken one shows scene A or B verbatim.
      for (const [name, t] of [
        ["scene-a-ref", "2.0"],
        ["pre-boundary", "3.8"],
        ["mid-transition", "4.0"],
        ["post-boundary", "4.2"],
        ["scene-b-ref", "6.0"],
      ] as const) {
        execFileSync("ffmpeg", [
          "-y",
          "-ss",
          t,
          "-i",
          outputPath,
          "-frames:v",
          "1",
          path.join(dir, `${name}.png`),
        ]);
      }

      if (process.env.KEEP_SMOKE_OUTPUT === "1") {
        console.log(`[m8-smoke] output kept at: ${dir}`);
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
