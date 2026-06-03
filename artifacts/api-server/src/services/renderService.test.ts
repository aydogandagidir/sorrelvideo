import { describe, expect, it } from "vitest";
import {
  injectWatermark,
  renderCompositionTemplate,
  resolveEntryFile,
} from "./renderService";

describe("renderCompositionTemplate", () => {
  it("substitutes simple {{key}} placeholders", () => {
    const out = renderCompositionTemplate(
      "<p>Hello {{ user.headline }}, brand: {{brand.companyName}}.</p>",
      { "user.headline": "World", "brand.companyName": "Acme" },
    );
    expect(out).toBe("<p>Hello World, brand: Acme.</p>");
  });

  it("HTML-escapes substituted values to prevent XSS", () => {
    const out = renderCompositionTemplate("<p>{{user.headline}}</p>", {
      "user.headline": "<script>alert(1)</script>",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("turns newlines in user.* values into <br/>", () => {
    const out = renderCompositionTemplate("<h1>{{user.headline}}</h1>", {
      "user.headline": "Line one\nLine two",
    });
    expect(out).toBe("<h1>Line one<br/>Line two</h1>");
  });

  it("does not turn newlines into <br/> for brand.* values", () => {
    const out = renderCompositionTemplate("<p>{{brand.companyName}}</p>", {
      "brand.companyName": "Foo\nBar",
    });
    // Newline survives but no <br/> injection.
    expect(out).toContain("Foo");
    expect(out).toContain("Bar");
    expect(out).not.toContain("<br/>");
  });

  it("leaves unknown placeholders intact (debug-friendly)", () => {
    const out = renderCompositionTemplate("<p>{{user.unknown}}</p>", {
      "brand.companyName": "X",
    });
    expect(out).toBe("<p>{{user.unknown}}</p>");
  });

  it("preserves quotes in brand.* values so CSS font-family survives", () => {
    const out = renderCompositionTemplate(
      "<style>font-family: {{brand.fontFamily}};</style>",
      { "brand.fontFamily": "'Inter'" },
    );
    expect(out).toBe("<style>font-family: 'Inter';</style>");
    expect(out).not.toContain("&#39;");
  });

  it("still markup-escapes brand.* values to prevent style/HTML breakout", () => {
    const out = renderCompositionTemplate("<p>{{brand.companyName}}</p>", {
      "brand.companyName": "</style><script>x</script>",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("injectWatermark", () => {
  const doc = "<html><body><h1>Hi</h1></body></html>";

  it("injects the badge immediately before </body>", () => {
    const out = injectWatermark(doc);
    expect(out).toContain('data-sorrel-watermark="true"');
    expect(out).toContain("Made with Sorrel");
    // Badge sits inside the body, right before the closing tag.
    expect(out.indexOf("data-sorrel-watermark")).toBeLessThan(
      out.indexOf("</body>"),
    );
    expect(out.indexOf("<h1>Hi</h1>")).toBeLessThan(
      out.indexOf("data-sorrel-watermark"),
    );
  });

  it("is a no-op marker absent until injected (absence is detectable)", () => {
    expect(doc).not.toContain("data-sorrel-watermark");
  });

  it("uses pointer-events:none and a high z-index so it can't be interacted with or buried", () => {
    const out = injectWatermark(doc);
    expect(out).toContain("pointer-events:none");
    expect(out).toContain("z-index:2147483647");
    expect(out).toContain("position:fixed");
  });

  it("uses only inline styles — no external asset/CDN reference", () => {
    const out = injectWatermark(doc);
    expect(out).not.toMatch(/<link\b/i);
    expect(out).not.toMatch(/src=/i);
    expect(out).not.toMatch(/https?:\/\//i);
  });

  it("matches the LAST </body> case-insensitively", () => {
    const upper = "<HTML><BODY>x</BODY></HTML>";
    const out = injectWatermark(upper);
    expect(out).toContain("data-sorrel-watermark");
    expect(out.indexOf("data-sorrel-watermark")).toBeLessThan(
      out.toLowerCase().indexOf("</body>"),
    );
  });

  it("appends (never drops) the badge when there is no closing body tag", () => {
    const out = injectWatermark("<div>no body tag</div>");
    expect(out).toContain("data-sorrel-watermark");
    // Original content stays first; the badge is appended after it.
    expect(out.indexOf("no body tag")).toBeLessThan(
      out.indexOf("data-sorrel-watermark"),
    );
    expect(out).toMatch(/data-sorrel-watermark[^]*<\/div>$/);
  });

  it("injects exactly one badge", () => {
    const out = injectWatermark(doc);
    expect(out.match(/data-sorrel-watermark/g)).toHaveLength(1);
  });
});

describe("resolveEntryFile", () => {
  it("returns the studio composition for the studio module", () => {
    expect(resolveEntryFile("studio")).toBe("studio-default.html");
  });

  it("returns the default composition for unknown modules", () => {
    expect(resolveEntryFile("does-not-exist")).toBe("product-launch.html");
  });
});
