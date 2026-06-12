import { describe, expect, it } from "vitest";
import type { RenderCaptionStyle } from "@workspace/db";
import { buildCaptionOverlay } from "./captionStyles";

const WORDS = [
  { text: "Hello", start: 0, end: 0.5 },
  { text: "brave", start: 0.5, end: 1 },
  { text: "world", start: 1, end: 1.5 },
];

const PRESETS: RenderCaptionStyle[] = [
  "pill-karaoke",
  "neon-accent",
  "kinetic-slam",
];

describe("buildCaptionOverlay", () => {
  it("returns '' when there are no words", () => {
    expect(buildCaptionOverlay([])).toBe("");
    for (const style of PRESETS) expect(buildCaptionOverlay([], style)).toBe("");
  });

  it("classic is the default — absent / 'classic' / unknown all match", () => {
    const base = buildCaptionOverlay(WORDS);
    expect(buildCaptionOverlay(WORDS, "classic")).toBe(base);
    // An unknown style falls through to classic (defensive — the sanitizer
    // already drops unknowns, but the builder must not throw).
    expect(buildCaptionOverlay(WORDS, "bogus" as RenderCaptionStyle)).toBe(base);
  });

  it("classic keeps the original overlay shape (regression pin)", () => {
    const html = buildCaptionOverlay(WORDS);
    // The byte-identical legacy markers: the fixed stage + the root-timeline
    // discovery snippet + the original sizing. If any of these change, the
    // overlay moved off its proven path.
    expect(html).toContain("data-sorrel-captions");
    expect(html).toContain("bottom:9%");
    expect(html).toContain("font-size:5.2vh");
    expect(html).toContain("window.__timelines");
    expect(html).toContain('[data-composition-id]');
    expect(html).toContain('querySelectorAll(\'.__cap\')');
  });

  it.each([["classic", undefined], ...PRESETS.map((s) => [s, s] as const)])(
    "%s: stages captions on the root timeline and escapes word text",
    (_label, style) => {
      const html = buildCaptionOverlay(WORDS, style as RenderCaptionStyle);
      expect(html).toContain("data-sorrel-captions");
      // Every style appends to the ROOT timeline (never a standalone one).
      expect(html).toContain("window.__timelines");
      expect(html).toContain("data-composition-id");
      // The plain word text is present (HTML-escaped, but Hello has no specials).
      expect(html).toContain("Hello");
    },
  );

  it.each([["classic", undefined], ...PRESETS.map((s) => [s, s] as const)])(
    "%s: escapes an adversarial word so it can't break out of the markup",
    (_label, style) => {
      const evil = [
        { text: "</script><img src=x onerror=alert(1)>", start: 0, end: 1 },
      ];
      const html = buildCaptionOverlay(evil, style as RenderCaptionStyle);
      // The raw closing tag must never appear verbatim — it's HTML-escaped.
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).toContain("&lt;");
      // The time-window JSON is `<`-escaped for the script context.
      expect(html).not.toMatch(/var W=\[\[0,1\]\];[^]*<\/script><img/);
    },
  );
});
