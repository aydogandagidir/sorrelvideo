import { describe, expect, it } from "vitest";
import {
  parseCssColor,
  toHex,
  parseToHex,
  saturation,
  isNeutral,
  luminance,
  ensureReadableOnDark,
  mergeCandidates,
  pickBrandColors,
  sanitizeFontFamily,
  type ColorCandidate,
} from "./brandColors";

describe("parseCssColor", () => {
  it("parses rgb() / rgba() the browser emits", () => {
    expect(parseCssColor("rgb(99, 102, 241)")).toEqual({ r: 99, g: 102, b: 241, a: 1 });
    expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });
  it("parses #hex in 3/6/8 forms", () => {
    expect(toHex(parseCssColor("#f00")!)).toBe("#ff0000");
    expect(toHex(parseCssColor("#6366f1")!)).toBe("#6366f1");
    expect(parseCssColor("#6366f180")?.a).toBeCloseTo(0.5, 1);
  });
  it("handles named transparent/white/black and rejects junk", () => {
    expect(parseCssColor("transparent")?.a).toBe(0);
    expect(toHex(parseCssColor("white")!)).toBe("#ffffff");
    expect(parseCssColor("not-a-color")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});

describe("parseToHex", () => {
  it("normalises to #rrggbb and drops fully transparent", () => {
    expect(parseToHex("rgb(255,0,0)")).toBe("#ff0000");
    expect(parseToHex("rgba(0,0,0,0)")).toBeNull();
    expect(parseToHex("garbage")).toBeNull();
  });
});

describe("saturation / isNeutral", () => {
  it("greys and near-white/black are neutral; vivid colors are not", () => {
    expect(saturation("#808080")).toBeLessThan(0.05);
    expect(isNeutral("#ffffff")).toBe(true);
    expect(isNeutral("#000000")).toBe(true);
    expect(isNeutral("#0b0b0f")).toBe(true);
    expect(isNeutral("#f3f4f6")).toBe(true);
    expect(isNeutral("#6366f1")).toBe(false);
    expect(isNeutral("#e11d48")).toBe(false);
  });
});

describe("mergeCandidates", () => {
  it("dedupes by hex, sums weights, drops unparseable", () => {
    const merged = mergeCandidates([
      { hex: "rgb(99,102,241)", source: "cta", weight: 0.3 },
      { hex: "#6366f1", source: "link", weight: 0.4 },
      { hex: "not-a-color", source: "x", weight: 1 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].hex).toBe("#6366f1");
    expect(merged[0].weight).toBeCloseTo(0.7, 5);
  });
});

describe("pickBrandColors", () => {
  it("picks a vivid prominent color as primary over neutrals", () => {
    const candidates: ColorCandidate[] = [
      { hex: "#ffffff", source: "background", weight: 0.9 },
      { hex: "#0b0b0f", source: "text", weight: 0.5 },
      { hex: "#e11d48", source: "cta", weight: 0.4 },
    ];
    const { primaryColor, secondaryColor } = pickBrandColors(candidates, null);
    expect(primaryColor).toBe("#e11d48");
    // Secondary is a distinct color (not the same as primary).
    expect(secondaryColor).not.toBe(primaryColor);
  });

  it("uses a vivid theme-color when the page palette is otherwise neutral", () => {
    const { primaryColor } = pickBrandColors(
      [{ hex: "#ffffff", source: "background", weight: 1 }],
      "#16a34a",
    );
    expect(primaryColor).toBe("#16a34a");
  });

  it("falls back to a sane default with no candidates", () => {
    const { primaryColor, secondaryColor } = pickBrandColors([], null);
    expect(primaryColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(secondaryColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("ignores negligible-weight vivid noise for secondary/accent (bluedev.dev case)", () => {
    // Real capture shape from bluedev.dev: a strong CTA blue, a strong dark
    // slate base, and a ~0.006-weight dark-green background swatch. The green
    // must NOT become the gradient's far stop / the accent — the page's true
    // dark base wins.
    const candidates: ColorCandidate[] = [
      { hex: "#015aff", source: "cta", weight: 1.1 },
      { hex: "#0f172a", source: "link", weight: 0.85 },
      { hex: "#0f3d2e", source: "background", weight: 0.0058 },
    ];
    const { primaryColor, secondaryColor, accentColor } = pickBrandColors(
      candidates,
      null,
    );
    expect(primaryColor).toBe("#015aff");
    expect(secondaryColor).toBe("#0f172a"); // darkest neutral — the dark base
    expect(accentColor).toBeNull(); // noise must not be promoted to accent
  });

  it("still lets a genuinely used second brand color claim secondary", () => {
    const candidates: ColorCandidate[] = [
      { hex: "#015aff", source: "cta", weight: 1.0 },
      { hex: "#10b981", source: "link", weight: 0.4 }, // real, weight-bearing green
      { hex: "#0b0b0f", source: "text", weight: 0.3 },
    ];
    const { secondaryColor } = pickBrandColors(candidates, null);
    expect(secondaryColor).toBe("#10b981");
  });
});

describe("sanitizeFontFamily", () => {
  it("takes the first family and strips quotes", () => {
    expect(sanitizeFontFamily('"Inter", sans-serif')).toBe("Inter");
    expect(sanitizeFontFamily("Poppins, Arial, sans-serif")).toBe("Poppins");
  });
  it("rejects generic families and CSS-breakout characters", () => {
    expect(sanitizeFontFamily("sans-serif")).toBeNull();
    expect(sanitizeFontFamily("system-ui")).toBeNull();
    expect(sanitizeFontFamily("Inter'; background:url(x)")).toBeNull();
    expect(sanitizeFontFamily("")).toBeNull();
    expect(sanitizeFontFamily(null)).toBeNull();
  });
});

describe("ensureReadableOnDark", () => {
  it("lightens a near-black brand accent to a readable luminance", () => {
    // The real regression: aremka.com auto-extracted #1f1f1f as its accent, so
    // the headline gradient (white → accent) + CTA rendered all but invisible.
    const fixed = ensureReadableOnDark("#1f1f1f");
    expect(luminance("#1f1f1f")).toBeLessThan(0.15);
    expect(luminance(fixed)).toBeGreaterThanOrEqual(0.4);
    // still a neutral grey (hue preserved), just lighter.
    expect(saturation(fixed)).toBeLessThan(0.1);
  });

  it("preserves hue when lightening a dark colored brand", () => {
    const fixed = ensureReadableOnDark("#0a1a3f"); // very dark navy
    expect(luminance(fixed)).toBeGreaterThanOrEqual(0.4);
    const rgb = parseCssColor(fixed)!;
    expect(rgb.b).toBeGreaterThan(rgb.r); // still blue-dominant
  });

  it("leaves bright/mid colors and the studio defaults untouched", () => {
    for (const hex of ["#f59e0b", "#6366f1", "#979797", "#cdfb45", "#ffffff"]) {
      expect(ensureReadableOnDark(hex)).toBe(hex);
    }
  });

  it("returns the input unchanged when it can't be parsed", () => {
    expect(ensureReadableOnDark("not-a-color")).toBe("not-a-color");
  });
});
