import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The "describe your video" AI tour wiring: a prompt + a captured page's sections
 * → the AI picks/orders them → the project carries `capture.tour` (and NO single
 * crop), so the composition renders a curated pan/zoom reel instead of a scroll.
 * Capture (headless Chrome) and the LLM are mocked; the rest (buildTour, the var
 * map, the DB insert) is real.
 */

const pickSections = vi.fn();
vi.mock("@workspace/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/ai")>();
  return {
    ...actual,
    getProvider: () => ({ name: "anthropic" as const, pickSections }),
  };
});

const captureWebsite = vi.fn();
vi.mock("../services/websiteCaptureService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/websiteCaptureService")>();
  return { ...actual, captureWebsite };
});

const { createWebsiteVideoProject } = await import("./websiteToVideoService");
const { createBrandKit } = await import("./brandKitService");
const { createFreeUser, truncateAll } = await import("../test/integration");
const { INTEGRATION_AVAILABLE } = await import("../test/setup");

// A real 1×1 JPEG-ish file on disk — the service reads it to build the data URI.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
let shotDir = "";
let shotPath = "";

function captureWith(sections: { label: string; crop: unknown }[]) {
  return {
    url: "https://acme.test",
    title: "Acme",
    themeColor: null,
    screenshotPath: shotPath,
    mediaType: "image/jpeg" as const,
    width: 1280,
    height: 4000,
    selectorCrop: undefined,
    sections,
    brand: undefined,
  };
}

const SECTIONS = [
  { label: "Hero — Acme", crop: { x: 0, y: 0, w: 1, h: 0.2 } },
  { label: "Our products", crop: { x: 0, y: 0.4, w: 1, h: 0.2 } },
  { label: "Contact us", crop: { x: 0, y: 0.8, w: 1, h: 0.2 } },
];

beforeEach(async () => {
  await truncateAll();
  pickSections.mockReset();
  captureWebsite.mockReset();
  shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2v-tour-test-"));
  shotPath = path.join(shotDir, "shot.jpg");
  fs.writeFileSync(shotPath, PNG_1PX);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (shotDir) fs.rmSync(shotDir, { recursive: true, force: true });
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "createWebsiteVideoProject — AI tour",
  () => {
    it("builds capture.tour from the AI picks (and no single crop)", async () => {
      const userId = await createFreeUser();
      // A pinned kit → no brand extraction (keeps this focused on the tour).
      const kit = await createBrandKit(userId, {
        name: "Acme",
        primaryColor: "#2563eb",
        isDefault: true,
      });
      captureWebsite.mockResolvedValue(captureWith(SECTIONS));
      pickSections.mockResolvedValue({
        picks: [
          { index: 0, seconds: 3, caption: "Welcome" },
          { index: 2, seconds: 2, caption: "Get in touch" },
        ],
        usage: { inputTokens: 50, outputTokens: 20 },
      });

      const project = await createWebsiteVideoProject(userId, {
        url: "https://acme.test",
        aiPrompt: "show the hero and the contact section",
        brandKitId: kit.id,
      });

      const vars = project.compositionVars as Record<string, string>;
      // A tour is present; the single-crop vars are NOT (the tour owns the motion).
      expect(vars["capture.tour"]).toBeTruthy();
      expect(vars["capture.cropX"]).toBeUndefined();

      const beats = JSON.parse(
        Buffer.from(vars["capture.tour"], "base64").toString("utf-8"),
      );
      expect(beats).toHaveLength(2);
      // The picks mapped to their sections' crops, IN ORDER, with captions.
      expect(beats[0].cropY).toBe(0);
      expect(beats[0].caption).toBe("Welcome");
      expect(beats[1].cropY).toBe(0.8);
      expect(beats[1].caption).toBe("Get in touch");

      // The AI was asked with the captured section labels.
      expect(pickSections).toHaveBeenCalledTimes(1);
      const input = pickSections.mock.calls[0][0] as {
        prompt: string;
        sections: { label: string }[];
      };
      expect(input.sections.map((s) => s.label)).toEqual([
        "Hero — Acme",
        "Our products",
        "Contact us",
      ]);
    });

    it("falls back to the scroll (no tour) when the model fails", async () => {
      const userId = await createFreeUser();
      const kit = await createBrandKit(userId, {
        name: "Acme",
        primaryColor: "#2563eb",
        isDefault: true,
      });
      captureWebsite.mockResolvedValue(captureWith(SECTIONS));
      pickSections.mockRejectedValue(new Error("model exploded"));

      const project = await createWebsiteVideoProject(userId, {
        url: "https://acme.test",
        aiPrompt: "show the hero",
        brandKitId: kit.id,
      });

      const vars = project.compositionVars as Record<string, string>;
      expect(vars["capture.tour"]).toBeUndefined();
      // Whole-page scroll (no crop) — a usable video, not a hard failure.
      expect(vars["capture.cropX"]).toBeUndefined();
      expect(vars["capture.image"]).toContain("data:image/jpeg;base64,");
    });
  },
);
