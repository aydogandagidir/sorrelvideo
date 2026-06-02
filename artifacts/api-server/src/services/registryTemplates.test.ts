import { describe, expect, it } from "vitest";
import {
  REGISTRY_TEMPLATES,
  REGISTRY_COMPOSITION_MAP,
  resolutionForModule,
} from "./registryTemplates";

describe("registry templates manifest", () => {
  it("exposes a composition file per template", () => {
    expect(REGISTRY_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of REGISTRY_TEMPLATES) {
      expect(REGISTRY_COMPOSITION_MAP[t.slug]).toBe(`${t.slug}.html`);
    }
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
