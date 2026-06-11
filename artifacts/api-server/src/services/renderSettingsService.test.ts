import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_SETTINGS, type RenderSettings } from "@workspace/db";
import {
  resolveSettings,
  assertRenderSettingsAllowed,
  resolveDimensions,
  toEngineConfig,
  formatSupportsAlpha,
  RenderSettingsUpgradeError,
} from "./renderSettingsService";

const proSettings: RenderSettings = {
  fps: 60,
  quality: "high",
  format: "webm",
  resolution: "landscape-4k",
  transparent: true,
  watermark: false,
};

describe("resolveSettings", () => {
  it("returns the defaults for null/undefined (preserves pre-settings output)", () => {
    expect(resolveSettings(null)).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(resolveSettings(undefined)).toEqual(DEFAULT_RENDER_SETTINGS);
    expect(resolveSettings({})).toEqual(DEFAULT_RENDER_SETTINGS);
  });

  it("merges a partial object over the defaults", () => {
    const out = resolveSettings({ quality: "standard", fps: 24 });
    expect(out.quality).toBe("standard");
    expect(out.fps).toBe(24);
    expect(out.format).toBe(DEFAULT_RENDER_SETTINGS.format);
    expect(out.resolution).toBe(DEFAULT_RENDER_SETTINGS.resolution);
  });

  it("falls back to defaults for invalid/malformed values", () => {
    // Simulates a malformed `render_settings` jsonb blob from the DB.
    const malformed = {
      fps: 48,
      quality: "ultra",
      format: "avi",
      resolution: "4:3",
      transparent: "yes",
    } as unknown as Partial<RenderSettings>;
    expect(resolveSettings(malformed)).toEqual(DEFAULT_RENDER_SETTINGS);
  });

  it("keeps transitions only when an array", () => {
    expect(resolveSettings({}).transitions).toBeUndefined();
    const t = [{ time: 1, shader: "whip-pan", duration: 0.5, ease: "power2.inOut" }];
    expect(resolveSettings({ transitions: t }).transitions).toEqual(t);
  });

  it("keeps a well-formed backgroundAudio (clamps volume); drops malformed", () => {
    expect(
      resolveSettings({
        backgroundAudio: { objectPath: "/objects/uploads/a", volume: 250 },
      }).backgroundAudio,
    ).toEqual({ objectPath: "/objects/uploads/a", volume: 100 });
    // A non-"/objects/" path is dropped (the route/render-time ACL is the real gate).
    expect(
      resolveSettings({
        backgroundAudio: { objectPath: "http://evil/x", volume: 50 },
      }).backgroundAudio,
    ).toBeUndefined();
    expect(resolveSettings({}).backgroundAudio).toBeUndefined();
  });

  it("keeps well-formed captions and drops malformed words", () => {
    const out = resolveSettings({
      captions: {
        words: [
          { text: "hello", start: 0, end: 1 },
          { text: "", start: 1, end: 2 }, // empty text → dropped
          { text: "bad", start: 2, end: 2 }, // end <= start → dropped
          { text: "world", start: 2, end: 3 },
        ],
      },
    });
    expect(out.captions?.words).toEqual([
      { text: "hello", start: 0, end: 1 },
      { text: "world", start: 2, end: 3 },
    ]);
    // No valid words → no captions at all.
    expect(resolveSettings({ captions: { words: [] } }).captions).toBeUndefined();
    expect(resolveSettings({}).captions).toBeUndefined();
  });

  it("preserves a well-formed voiceover (the talking-host narration MUST survive re-resolve)", () => {
    // executeRender re-resolves the jsonb column — if this drops, the video is mute.
    expect(
      resolveSettings({
        voiceover: { objectPath: "/objects/uploads/v", startAt: 0.9, volume: 100 },
      }).voiceover,
    ).toEqual({ objectPath: "/objects/uploads/v", startAt: 0.9, volume: 100 });
    // null objectPath is valid: the local renders/<id>/voice.mp3 copy is the source.
    expect(
      resolveSettings({ voiceover: { objectPath: null, startAt: 1.5 } }).voiceover,
    ).toEqual({ objectPath: null, startAt: 1.5, volume: 100 });
  });

  it("clamps voiceover startAt/volume and drops malformed blobs", () => {
    expect(
      resolveSettings({
        voiceover: { objectPath: null, startAt: -3, volume: 250 },
      }).voiceover,
    ).toEqual({ objectPath: null, startAt: 0, volume: 100 });
    expect(
      resolveSettings({
        voiceover: { objectPath: null, startAt: 9999, volume: -1 },
      }).voiceover,
    ).toEqual({ objectPath: null, startAt: 600, volume: 0 });
    // Non-"/objects/" path → whole blob dropped (no half-trusted narration).
    expect(
      resolveSettings({
        voiceover: { objectPath: "http://evil/x", startAt: 0 },
      } as unknown as Partial<RenderSettings>).voiceover,
    ).toBeUndefined();
    expect(resolveSettings({ voiceover: null }).voiceover).toBeUndefined();
    expect(resolveSettings({}).voiceover).toBeUndefined();
  });

  it("keeps voiceover through a render-settings PATCH-style merge", () => {
    // PATCH /render-settings merges { ...existing, ...patch } then re-resolves;
    // a client patch (which can never contain voiceover) must not erase it.
    const existing = resolveSettings({
      voiceover: { objectPath: "/objects/uploads/v", startAt: 0.9, volume: 100 },
    });
    const merged = resolveSettings({ ...existing, quality: "standard" });
    expect(merged.quality).toBe("standard");
    expect(merged.voiceover).toEqual(existing.voiceover);
  });
});

describe("assertRenderSettingsAllowed", () => {
  it("allows any combination for Pro", () => {
    expect(() => assertRenderSettingsAllowed(proSettings, "pro")).not.toThrow();
  });

  it("allows the Free floor (defaults)", () => {
    expect(() =>
      assertRenderSettingsAllowed(DEFAULT_RENDER_SETTINGS, "free"),
    ).not.toThrow();
    expect(() =>
      assertRenderSettingsAllowed(
        resolveSettings({ quality: "standard", fps: 24, resolution: "square" }),
        "free",
      ),
    ).not.toThrow();
  });

  it.each([
    ["high quality", { quality: "high" as const }],
    ["60 fps", { fps: 60 as const }],
    ["4K", { resolution: "portrait-4k" as const }],
    ["non-mp4 format", { format: "mov" as const }],
    ["transparency", { transparent: true }],
    ["watermark removal", { watermark: false }],
    [
      "background audio",
      { backgroundAudio: { objectPath: "/objects/uploads/x", volume: 50 } },
    ],
    ["captions", { captions: { words: [{ text: "hi", start: 0, end: 1 }] } }],
  ])("rejects %s for Free with upgrade_required", (_label, partial) => {
    const settings = resolveSettings({ ...partial });
    let thrown: unknown;
    try {
      assertRenderSettingsAllowed(settings, "free");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RenderSettingsUpgradeError);
    expect((thrown as RenderSettingsUpgradeError).reason).toBe("upgrade_required");
    expect((thrown as RenderSettingsUpgradeError).status).toBe(403);
  });

  it("rejects more than one transition for Free", () => {
    const two = resolveSettings({
      transitions: [
        { time: 0, shader: "glitch", duration: 0.3, ease: "none" },
        { time: 1, shader: "whip-pan", duration: 0.3, ease: "none" },
      ],
    });
    expect(() => assertRenderSettingsAllowed(two, "free")).toThrow(
      RenderSettingsUpgradeError,
    );
  });

  it("does NOT gate voiceover for Free (talking-host auto-render must pass the render-time re-gate)", () => {
    // The flow that sets voiceover already charged an AI unit at creation;
    // gating here would 403 the render AFTER the spend and strand a draft.
    const settings = resolveSettings({
      voiceover: { objectPath: null, startAt: 0.9, volume: 100 },
    });
    expect(() => assertRenderSettingsAllowed(settings, "free")).not.toThrow();
  });
});

describe("toEngineConfig", () => {
  it("maps fps to an exact rational and passes through quality/format/entryFile", () => {
    const cfg = toEngineConfig(resolveSettings({ fps: 60, quality: "high" }), "composition.html");
    expect(cfg.fps).toEqual({ num: 60, den: 1 });
    expect(cfg.quality).toBe("high");
    expect(cfg.entryFile).toBe("composition.html");
    expect(cfg.outputResolution).toBe(DEFAULT_RENDER_SETTINGS.resolution);
  });

  it("defaults reproduce the legacy 30fps/draft/mp4 config", () => {
    const cfg = toEngineConfig(DEFAULT_RENDER_SETTINGS, "composition.html");
    expect(cfg.fps).toEqual({ num: 30, den: 1 });
    expect(cfg.quality).toBe("draft");
    expect(cfg.format).toBe("mp4");
  });

  it("does NOT emit a `transparent` field — alpha is format-derived by the engine", () => {
    // The producer derives alpha from `format` (webm/mov/png-sequence); there is
    // no RenderConfig.transparent knob. A transparent webm still maps cleanly.
    const cfg = toEngineConfig(proSettings, "composition.html");
    expect("transparent" in cfg).toBe(false);
    expect(cfg.format).toBe("webm");
  });

  it("forwards outputResolution for opaque mp4 (legacy behavior preserved)", () => {
    const cfg = toEngineConfig(
      resolveSettings({ format: "mp4", resolution: "landscape" }),
      "composition.html",
    );
    expect(cfg.outputResolution).toBe("landscape");
  });

  it("OMITS outputResolution for alpha formats (engine forbids DPR + alpha)", () => {
    // resolveDeviceScaleFactor throws on outputResolution + alpha output, so a
    // transparent webm/mov/png-sequence render must NOT carry the preset or it
    // hard-fails. Alpha renders at composition resolution.
    for (const format of ["webm", "mov", "png-sequence"] as const) {
      const cfg = toEngineConfig(
        resolveSettings({ transparent: true, format, resolution: "portrait-4k" }),
        "composition.html",
      );
      expect(cfg.format).toBe(format);
      expect("outputResolution" in cfg).toBe(false);
    }
  });

  it("throws on the incoherent transparent+mp4 combo (never silently ships opaque)", () => {
    const incoherent = resolveSettings({ transparent: true, format: "mp4" });
    expect(() => toEngineConfig(incoherent, "composition.html")).toThrow(
      /alpha-capable format/i,
    );
  });

  it("allows transparent on each alpha-capable format", () => {
    for (const format of ["webm", "mov", "png-sequence"] as const) {
      const s = resolveSettings({ transparent: true, format });
      expect(() => toEngineConfig(s, "composition.html")).not.toThrow();
    }
  });

  it("caps workers at 2 by default (one render must not OOM a small box)", () => {
    const prev = process.env.RENDER_WORKERS;
    delete process.env.RENDER_WORKERS;
    try {
      expect(
        toEngineConfig(DEFAULT_RENDER_SETTINGS, "composition.html").workers,
      ).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.RENDER_WORKERS;
      else process.env.RENDER_WORKERS = prev;
    }
  });

  it("honors a valid RENDER_WORKERS override and ignores junk/non-positive", () => {
    const prev = process.env.RENDER_WORKERS;
    try {
      process.env.RENDER_WORKERS = "5";
      expect(
        toEngineConfig(DEFAULT_RENDER_SETTINGS, "composition.html").workers,
      ).toBe(5);
      process.env.RENDER_WORKERS = "0";
      expect(
        toEngineConfig(DEFAULT_RENDER_SETTINGS, "composition.html").workers,
      ).toBe(2);
      process.env.RENDER_WORKERS = "not-a-number";
      expect(
        toEngineConfig(DEFAULT_RENDER_SETTINGS, "composition.html").workers,
      ).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.RENDER_WORKERS;
      else process.env.RENDER_WORKERS = prev;
    }
  });
});

describe("formatSupportsAlpha", () => {
  it("is false only for mp4", () => {
    expect(formatSupportsAlpha("mp4")).toBe(false);
    expect(formatSupportsAlpha("webm")).toBe(true);
    expect(formatSupportsAlpha("mov")).toBe(true);
    expect(formatSupportsAlpha("png-sequence")).toBe(true);
  });
});

describe("resolveDimensions", () => {
  it("returns the engine CANVAS_DIMENSIONS for each preset", () => {
    expect(resolveDimensions("portrait")).toEqual({ width: 1080, height: 1920 });
    expect(resolveDimensions("landscape")).toEqual({ width: 1920, height: 1080 });
    expect(resolveDimensions("landscape-4k")).toEqual({ width: 3840, height: 2160 });
    expect(resolveDimensions("square")).toEqual({ width: 1080, height: 1080 });
  });
});
