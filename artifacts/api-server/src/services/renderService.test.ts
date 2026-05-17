import { describe, expect, it } from "vitest";
import { renderCompositionTemplate, resolveEntryFile } from "./renderService";

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
});

describe("resolveEntryFile", () => {
  it("returns the studio composition for the studio module", () => {
    expect(resolveEntryFile("studio")).toBe("studio-default.html");
  });

  it("returns the default composition for unknown modules", () => {
    expect(resolveEntryFile("does-not-exist")).toBe("product-launch.html");
  });
});
