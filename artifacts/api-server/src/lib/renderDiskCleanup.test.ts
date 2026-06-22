import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupProjectWorkDirs,
  reclaimOrphanRenderDisk,
} from "./renderDiskCleanup";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "render-clean-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Create a file, making parent dirs as needed. */
function touch(p: string, body = "x"): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe("cleanupProjectWorkDirs", () => {
  it("removes only `work-*` scratch dirs, never the served artifacts", async () => {
    const projectDir = path.join(root, "17");
    // Engine scratch (frames + intermediate mux) — must be reclaimed.
    touch(path.join(projectDir, "work-abc-1/frame_0.png"));
    touch(path.join(projectDir, "work-abc-1/video-only.mp4"));
    touch(path.join(projectDir, "work-def-2/frame_0.png"));
    // Served / persistent artifacts — must survive.
    touch(path.join(projectDir, "output.mp4"));
    touch(path.join(projectDir, "frames/frame_0.png")); // png-sequence output dir
    touch(path.join(projectDir, "composition.html"));
    touch(path.join(projectDir, "thumb.png"));
    touch(path.join(projectDir, "voice.mp3"));

    const removed = await cleanupProjectWorkDirs(projectDir);

    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(projectDir, "work-abc-1"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "work-def-2"))).toBe(false);
    // Everything that isn't a work dir is untouched.
    expect(fs.existsSync(path.join(projectDir, "output.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "frames/frame_0.png"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "composition.html"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "thumb.png"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "voice.mp3"))).toBe(true);
  });

  it("returns 0 and never throws for a missing project dir", async () => {
    await expect(
      cleanupProjectWorkDirs(path.join(root, "does-not-exist")),
    ).resolves.toBe(0);
  });
});

describe("reclaimOrphanRenderDisk", () => {
  it("sweeps `work-*` across every project but keeps outputs", async () => {
    touch(path.join(root, "1/work-a/frame_0.png"));
    touch(path.join(root, "1/output.mp4"));
    touch(path.join(root, "2/work-b/frame_0.png"));
    touch(path.join(root, "2/work-c/frame_0.png"));
    touch(path.join(root, "2/output.webm"));
    // A stray non-dir entry at the root must be ignored, not crash the sweep.
    touch(path.join(root, "README"));

    await reclaimOrphanRenderDisk(root);

    expect(fs.existsSync(path.join(root, "1/work-a"))).toBe(false);
    expect(fs.existsSync(path.join(root, "2/work-b"))).toBe(false);
    expect(fs.existsSync(path.join(root, "2/work-c"))).toBe(false);
    expect(fs.existsSync(path.join(root, "1/output.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(root, "2/output.webm"))).toBe(true);
    expect(fs.existsSync(path.join(root, "README"))).toBe(true);
  });

  it("never throws for a missing renders root", async () => {
    await expect(
      reclaimOrphanRenderDisk(path.join(root, "nope")),
    ).resolves.toBeUndefined();
  });
});
