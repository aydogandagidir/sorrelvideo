import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { loadVisionScreenshot } from "./visionImage";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-test-"));
});
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function writeImage(
  name: string,
  width: number,
  height: number,
): Promise<string> {
  const p = path.join(dir, name);
  await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toFile(p);
  return p;
}

describe("loadVisionScreenshot", () => {
  it("returns undefined for a missing file (text-only fallback)", async () => {
    const out = await loadVisionScreenshot(
      path.join(dir, "nope.png"),
      "image/png",
      500,
    );
    expect(out).toBeUndefined();
  });

  it("passes a short capture through untouched", async () => {
    const p = await writeImage("short.png", 400, 800);
    const out = await loadVisionScreenshot(p, "image/png", 800);
    expect(out?.mediaType).toBe("image/png");
    // Untouched = byte-identical to what's on disk.
    expect(out?.base64).toBe(fs.readFileSync(p).toString("base64"));
  });

  it("downscales a TALL capture below the vision ceiling and re-encodes JPEG", async () => {
    const p = await writeImage("tall.png", 1280, 9000);
    const out = await loadVisionScreenshot(p, "image/jpeg", 9000);
    expect(out?.mediaType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(out?.base64 ?? "", "base64")).metadata();
    expect(meta.height ?? 0).toBeLessThanOrEqual(1600);
    expect(meta.format).toBe("jpeg");
  });
});
