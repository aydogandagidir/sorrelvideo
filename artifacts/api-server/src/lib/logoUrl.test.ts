import { describe, expect, it } from "vitest";
import { isSafeLogoUrl } from "./logoUrl";

describe("isSafeLogoUrl", () => {
  it("allows empty / unset values (composition falls back to the abstract logo)", () => {
    expect(isSafeLogoUrl("")).toBe(true);
    expect(isSafeLogoUrl(null)).toBe(true);
    expect(isSafeLogoUrl(undefined)).toBe(true);
  });

  it("accepts plain http(s) URLs", () => {
    expect(isSafeLogoUrl("https://cdn.example.com/logo.png")).toBe(true);
    expect(isSafeLogoUrl("http://example.com/a/b/logo.svg")).toBe(true);
    // Hyphens, query strings and ports are legitimate URL syntax.
    expect(
      isSafeLogoUrl("https://my-brand.example.com:8443/logo.png?v=2"),
    ).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isSafeLogoUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLogoUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isSafeLogoUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeLogoUrl("ftp://example.com/logo.png")).toBe(false);
  });

  it("rejects values that could break out of the src=\"…\" attribute", () => {
    // A double quote closes the attribute; the rest would become live markup.
    expect(
      isSafeLogoUrl('https://x/y.png" onerror="alert(1)'),
    ).toBe(false);
    // Angle brackets / new elements.
    expect(isSafeLogoUrl("https://x/y.png><script>alert(1)</script>")).toBe(
      false,
    );
    // Single quote and backtick are rejected too (defense in depth).
    expect(isSafeLogoUrl("https://x/y.png'")).toBe(false);
    expect(isSafeLogoUrl("https://x/y.png`")).toBe(false);
  });

  it("rejects whitespace (obfuscation / not a real URL)", () => {
    expect(isSafeLogoUrl("https://x/ y.png")).toBe(false);
    expect(isSafeLogoUrl("https://x/y.png\n")).toBe(false);
    expect(isSafeLogoUrl("  https://x/y.png  ")).toBe(false);
  });

  it("rejects garbage that is not a URL at all", () => {
    expect(isSafeLogoUrl("not a url")).toBe(false);
    expect(isSafeLogoUrl("logo.png")).toBe(false);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(isSafeLogoUrl("https://user:pass@example.com/logo.png")).toBe(false);
  });
});
