import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  REGISTRY_TEMPLATES,
  REGISTRY_COMPOSITION_MAP,
  resolutionForModule,
  assetsForModule,
} from "./registryTemplates";

const COMPOSITIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "compositions",
);

describe("registry templates manifest", () => {
  it("exposes a composition file per template", () => {
    expect(REGISTRY_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of REGISTRY_TEMPLATES) {
      expect(REGISTRY_COMPOSITION_MAP[t.slug]).toBe(`${t.slug}.html`);
    }
  });

  it("every declared sibling asset exists on disk under assets/<slug>/", () => {
    const withAssets = REGISTRY_TEMPLATES.filter((t) => t.assets?.length);
    // The multi-file blocks vendored by the asset pipeline (social avatars, the
    // money-count sfx). Guards against a manifest that references a missing file.
    expect(withAssets.length).toBeGreaterThan(0);
    for (const t of withAssets) {
      for (const a of t.assets ?? []) {
        const p = path.join(COMPOSITIONS_DIR, "assets", t.slug, a.name);
        expect(existsSync(p), `${t.slug}/${a.name}`).toBe(true);
      }
    }
  });
});

describe("assetsForModule", () => {
  it("returns the declared asset names for a module with assets", () => {
    const withAssets = REGISTRY_TEMPLATES.find((t) => t.assets?.length);
    expect(withAssets).toBeDefined();
    if (withAssets) {
      expect(assetsForModule(withAssets.slug)).toEqual(
        withAssets.assets?.map((a) => a.name),
      );
    }
  });

  it("returns [] for a module with no assets / a non-registry module", () => {
    const single = REGISTRY_TEMPLATES.find((t) => !t.assets?.length);
    if (single) expect(assetsForModule(single.slug)).toEqual([]);
    expect(assetsForModule("studio")).toEqual([]);
    expect(assetsForModule("definitely-not-a-template")).toEqual([]);
  });
});

describe("resolutionForModule", () => {
  it("matches a registry template to its native aspect ratio", () => {
    // data-chart is authored 1920×1080 (landscape); spotify-card 1080×1920.
    expect(resolutionForModule("data-chart")).toBe("landscape");
    expect(resolutionForModule("spotify-card")).toBe("portrait");
  });

  it("derives orientation purely from the manifest's width/height", () => {
    for (const t of REGISTRY_TEMPLATES) {
      const expected =
        t.width > t.height
          ? "landscape"
          : t.height > t.width
            ? "portrait"
            : "square";
      expect(resolutionForModule(t.slug)).toBe(expected);
    }
  });

  it("returns null for non-registry modules (responsive hand-authored templates)", () => {
    expect(resolutionForModule("studio")).toBeNull();
    expect(resolutionForModule("definitely-not-a-template")).toBeNull();
  });
});
