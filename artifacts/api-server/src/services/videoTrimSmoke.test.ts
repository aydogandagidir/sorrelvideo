/**
 * Smart Trim FFmpeg engine END-TO-END smoke — drives the REAL `trimVideo` over a
 * synthetic source (no upload / no Whisper), proving the cut + concat + fade
 * pipeline emits a valid, shorter mp4 with both streams intact.
 *
 * GATED behind RENDER_SMOKE=1 (a real ffmpeg encode; needs the toolchain):
 *
 *   RENDER_SMOKE=1 pnpm exec vitest run \
 *     artifacts/api-server/src/services/videoTrimSmoke.test.ts
 *
 * Set KEEP_SMOKE_OUTPUT=1 to keep the temp dir (source.mp4 + output.mp4).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { trimVideo } from "./videoTrimService";

const SMOKE = process.env.RENDER_SMOKE === "1";

/** ffprobe a single numeric format/stream field. */
function probe(args: string[]): string {
  return execFileSync("ffprobe", ["-v", "error", ...args], {
    encoding: "utf-8",
  }).trim();
}

describe.runIf(SMOKE)("Smart Trim FFmpeg engine smoke", () => {
  it(
    "cuts a 6s source to its keep-segments and writes a valid ~2s mp4 with captions",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-trim-smoke-"));
      const sourcePath = path.join(dir, "source.mp4");
      const outputPath = path.join(dir, "output.mp4");
      const workDir = path.join(dir, "work-smoke");

      // 6s synthetic clip: test pattern video + a 440Hz tone.
      execFileSync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=6:size=320x240:rate=24",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        sourcePath,
      ]);

      // Keep [0,1] + [3,4] → ~2s out. Captions exercise the .ass burn path too.
      const { duration } = await trimVideo({
        sourcePath,
        segments: [
          { start: 0, end: 1 },
          { start: 3, end: 4 },
        ],
        outputPath,
        workDir,
        captions: [
          { text: "hello", start: 0.1, end: 0.5 },
          { text: "world", start: 0.6, end: 1.0 },
          { text: "smart", start: 1.2, end: 1.6 },
          { text: "trim", start: 1.7, end: 1.95 },
        ],
        brandColor: "#a3e635",
      });

      expect(duration).toBeCloseTo(2, 6);

      const stat = fs.statSync(outputPath);
      expect(stat.size).toBeGreaterThan(10_000);

      // Duration ≈ 2s (the two 1s kept spans).
      const probed = parseFloat(
        probe([
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          outputPath,
        ]),
      );
      expect(Math.abs(probed - 2)).toBeLessThan(0.4);

      // Both a video and an audio stream survived the concat.
      const codecs = probe([
        "-select_streams",
        "v",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        outputPath,
      ]);
      expect(codecs).toContain("video");
      const acodecs = probe([
        "-select_streams",
        "a",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        outputPath,
      ]);
      expect(acodecs).toContain("audio");

      if (process.env.KEEP_SMOKE_OUTPUT === "1") {
        console.log(`[trim-smoke] output kept at: ${dir}`);
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
