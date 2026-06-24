import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/**
 * The "describe your video" AI tour wiring: a prompt + a captured page's sections
 * → the AI picks/orders them → the project carries `capture.tour` (and NO single
 * crop), so the composition renders a curated pan/zoom reel instead of a scroll.
 * Capture (headless Chrome) and the LLM are mocked; the rest (buildTour, the var
 * map, the DB insert) is real.
 */

const pickSections = vi.fn();
const judgeTours = vi.fn();
vi.mock("@workspace/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/ai")>();
  return {
    ...actual,
    getProvider: () => ({ name: "anthropic" as const, pickSections, judgeTours }),
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
  // The AI tour is gated by `isAiConfigured()` (a provider key must be present)
  // BEFORE `getProvider().pickSections` is ever called — so mocking the provider
  // alone is not enough. CI has no ANTHROPIC_API_KEY, so without this the gate
  // closes, `buildAiTour` returns null, and `capture.tour` is undefined. Stub the
  // default (anthropic) key so the gate opens; the provider itself stays mocked.
  vi.stubEnv("AI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  pickSections.mockReset();
  judgeTours.mockReset();
  captureWebsite.mockReset();
  shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2v-tour-test-"));
  shotPath = path.join(shotDir, "shot.jpg");
  // A REAL (sharp-decodable) image — the service reads it for the capture.image
  // data URI AND the vision judge downscales it (a 1×1 PNG fails libpng decode).
  await sharp({
    create: {
      width: 200,
      height: 400,
      channels: 3,
      background: { r: 9, g: 37, b: 235 },
    },
  })
    .jpeg()
    .toFile(shotPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
      // Both candidate calls return the same picks → identical candidates; the
      // vision judge picks index 0. (A distinct-candidate selection is its own
      // test below.)
      pickSections.mockResolvedValue({
        picks: [
          { index: 0, seconds: 3, caption: "Welcome" },
          { index: 2, seconds: 2, caption: "Get in touch" },
        ],
        usage: { inputTokens: 50, outputTokens: 20 },
      });
      judgeTours.mockResolvedValue({
        bestIndex: 0,
        reason: "Leads with the hero and ends on contact.",
        usage: { inputTokens: 30, outputTokens: 10 },
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

      // Two candidate tours are generated (base + variant), then the vision judge
      // picks one. The first call carries the captured section labels.
      expect(pickSections).toHaveBeenCalledTimes(2);
      expect(judgeTours).toHaveBeenCalledTimes(1);
      const input = pickSections.mock.calls[0][0] as {
        prompt: string;
        sections: { label: string }[];
      };
      expect(input.sections.map((s) => s.label)).toEqual([
        "Hero — Acme",
        "Our products",
        "Contact us",
      ]);
      // The judge was handed BOTH candidates + the (downscaled) page screenshot.
      const judgeInput = judgeTours.mock.calls[0][0] as {
        candidates: unknown[];
        screenshot?: { base64: string };
      };
      expect(judgeInput.candidates).toHaveLength(2);
      expect(judgeInput.screenshot?.base64).toBeTruthy();
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

    it("honors the vision judge's pick among distinct candidates", async () => {
      const userId = await createFreeUser();
      const kit = await createBrandKit(userId, {
        name: "Acme",
        primaryColor: "#2563eb",
        isDefault: true,
      });
      captureWebsite.mockResolvedValue(captureWith(SECTIONS));
      // Two DIFFERENT candidates: A = hero only; B = products only.
      pickSections
        .mockResolvedValueOnce({
          picks: [{ index: 0, seconds: 3, caption: "A" }],
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          picks: [{ index: 1, seconds: 3, caption: "B" }],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      // The judge prefers candidate 1 (the products beat at y=0.4).
      judgeTours.mockResolvedValue({
        bestIndex: 1,
        reason: "Products section is the strongest.",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const project = await createWebsiteVideoProject(userId, {
        url: "https://acme.test",
        aiPrompt: "show what matters",
        brandKitId: kit.id,
      });

      const vars = project.compositionVars as Record<string, string>;
      const beats = JSON.parse(
        Buffer.from(vars["capture.tour"], "base64").toString("utf-8"),
      );
      // Candidate 1 (index 1) was chosen: a single beat over the products section.
      expect(beats).toHaveLength(1);
      expect(beats[0].cropY).toBe(0.4);
      expect(beats[0].caption).toBe("B");
    });
  },
);
