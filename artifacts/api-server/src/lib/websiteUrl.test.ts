import { describe, expect, it } from "vitest";
import { normalizeWebsiteUrl } from "./websiteUrl";

describe("normalizeWebsiteUrl", () => {
  it("prepends https:// to a bare host (the reported bug)", () => {
    expect(normalizeWebsiteUrl("bluedev.dev")).toBe("https://bluedev.dev");
  });

  it("prepends https:// to a bare host with a path", () => {
    expect(normalizeWebsiteUrl("example.com/pricing")).toBe(
      "https://example.com/pricing",
    );
  });

  it("preserves an explicit https:// URL", () => {
    expect(normalizeWebsiteUrl("https://bluedev.dev/path")).toBe(
      "https://bluedev.dev/path",
    );
  });

  it("preserves an explicit http:// URL (no upgrade to https)", () => {
    expect(normalizeWebsiteUrl("http://example.com")).toBe("http://example.com");
  });

  it("is case-insensitive about the existing scheme", () => {
    expect(normalizeWebsiteUrl("HTTPS://example.com")).toBe(
      "HTTPS://example.com",
    );
  });

  it("trims surrounding whitespace before prefixing", () => {
    expect(normalizeWebsiteUrl("  bluedev.dev  ")).toBe("https://bluedev.dev");
  });

  it("returns empty for blank input (rejected downstream, not turned into https://)", () => {
    expect(normalizeWebsiteUrl("   ")).toBe("");
  });

  it("does NOT let a non-http scheme pass — it becomes an invalid URL downstream", () => {
    // "ftp://x" / "javascript:..." get https:// prefixed, yielding a string that
    // `new URL()` / assertSafeUrl rejects — so SSRF protection is unchanged.
    expect(normalizeWebsiteUrl("ftp://x")).toBe("https://ftp://x");
    expect(normalizeWebsiteUrl("javascript:alert(1)")).toBe(
      "https://javascript:alert(1)",
    );
  });
});
