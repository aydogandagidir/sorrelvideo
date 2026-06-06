import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  savePreview,
  consumePreview,
  createPreviewDir,
  disposePreview,
} from "./websitePreviewStore";

function makeEntry(userId: string) {
  const dir = createPreviewDir();
  const screenshotPath = path.join(dir, "capture.png");
  fs.writeFileSync(screenshotPath, "x");
  return {
    screenshotPath,
    dir,
    title: "t",
    url: "https://example.test",
    captureHeight: 800,
    mediaType: "image/jpeg" as const,
    themeColor: null,
    userId,
  };
}

describe("websitePreviewStore", () => {
  it("returns the preview for its owner, then is single-use", () => {
    const e = makeEntry("user-1");
    const id = savePreview(e);
    const got = consumePreview(id, "user-1");
    expect(got?.url).toBe("https://example.test");
    expect(got?.captureHeight).toBe(800);
    // A second consume of the same id is a no-op — the render can't be replayed.
    expect(consumePreview(id, "user-1")).toBeNull();
    disposePreview(e);
  });

  it("refuses a different owner and burns the id (no owner-id enumeration)", () => {
    const e = makeEntry("owner");
    const id = savePreview(e);
    // Wrong owner → null AND the entry is dropped, so a later correct-owner call
    // also gets null. The id is opaque; a miss never reveals why.
    expect(consumePreview(id, "attacker")).toBeNull();
    expect(consumePreview(id, "owner")).toBeNull();
  });

  it("returns null for an unknown id", () => {
    expect(consumePreview("does-not-exist", "user-1")).toBeNull();
  });
});
