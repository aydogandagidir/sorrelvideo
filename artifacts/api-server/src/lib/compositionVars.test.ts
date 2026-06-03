import { describe, expect, it } from "vitest";
import {
  findUnsafeCompositionVar,
  assertSafeCompositionVars,
  isSafeCssColor,
  UnsafeCompositionVarError,
} from "./compositionVars";

describe("findUnsafeCompositionVar — URL/attribute keys", () => {
  it("rejects a brand.logoUrl that breaks out of the src=\"…\" attribute", () => {
    const violation = findUnsafeCompositionVar({
      "brand.logoUrl": 'https://x/y.png" onerror="alert(1)',
    });
    expect(violation?.key).toBe("brand.logoUrl");
  });

  it("rejects non-http(s) brand.logoUrl schemes", () => {
    expect(
      findUnsafeCompositionVar({ "brand.logoUrl": "javascript:alert(1)" })?.key,
    ).toBe("brand.logoUrl");
    // A data: URI is NOT acceptable for the plain-URL logo key.
    expect(
      findUnsafeCompositionVar({
        "brand.logoUrl": "data:image/png;base64,AAAA",
      })?.key,
    ).toBe("brand.logoUrl");
  });

  it("accepts a clean http(s) brand.logoUrl", () => {
    expect(
      findUnsafeCompositionVar({
        "brand.logoUrl": "https://cdn.example.com/logo.png",
      }),
    ).toBeNull();
  });

  it("rejects a capture.image that breaks out of the src=\"…\" attribute", () => {
    expect(
      findUnsafeCompositionVar({
        "capture.image": 'x" onerror="alert(1)',
      })?.key,
    ).toBe("capture.image");
  });

  it("rejects a non-image / scriptable data URI for capture.image", () => {
    expect(
      findUnsafeCompositionVar({
        "capture.image": "data:text/html,<script>alert(1)</script>",
      })?.key,
    ).toBe("capture.image");
    // SVG can carry markup, so it is not an allowed image data URI subtype.
    expect(
      findUnsafeCompositionVar({
        "capture.image": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      })?.key,
    ).toBe("capture.image");
  });

  it("accepts the website→video screenshot data URI (image/png;base64)", () => {
    // The exact shape websiteToVideoService produces.
    const dataUri =
      "data:image/png;base64," +
      Buffer.from("not-a-real-png").toString("base64");
    expect(
      findUnsafeCompositionVar({ "capture.image": dataUri }),
    ).toBeNull();
  });

  it("accepts an http(s) URL for capture.image", () => {
    expect(
      findUnsafeCompositionVar({
        "capture.image": "https://cdn.example.com/shot.png",
      }),
    ).toBeNull();
  });
});

describe("findUnsafeCompositionVar — color keys", () => {
  it("rejects a color that injects a CSS url() for exfiltration", () => {
    expect(
      findUnsafeCompositionVar({
        "brand.primaryColor": "red;background:url(https://evil.example/x)",
      })?.key,
    ).toBe("brand.primaryColor");
  });

  it("rejects a color that closes the style block / injects markup", () => {
    expect(
      findUnsafeCompositionVar({
        "brand.accentColor": "#fff</style><script>alert(1)</script>",
      })?.key,
    ).toBe("brand.accentColor");
  });

  it("accepts hex and functional colors for every color key", () => {
    expect(
      findUnsafeCompositionVar({
        "brand.primaryColor": "#6366f1",
        "brand.secondaryColor": "rgb(30, 41, 59)",
        "brand.accentColor": "hsl(38 92% 50%)",
      }),
    ).toBeNull();
  });
});

describe("isSafeCssColor", () => {
  it("allows empty / unset (composition falls back to a default)", () => {
    expect(isSafeCssColor("")).toBe(true);
    expect(isSafeCssColor(null)).toBe(true);
    expect(isSafeCssColor(undefined)).toBe(true);
  });

  it("allows 3/4/6/8-digit hex", () => {
    expect(isSafeCssColor("#fff")).toBe(true);
    expect(isSafeCssColor("#ffff")).toBe(true);
    expect(isSafeCssColor("#6366f1")).toBe(true);
    expect(isSafeCssColor("#6366f1aa")).toBe(true);
  });

  it("rejects malformed hex lengths and non-hex digits", () => {
    expect(isSafeCssColor("#ff")).toBe(false);
    expect(isSafeCssColor("#fffff")).toBe(false);
    expect(isSafeCssColor("#gggggg")).toBe(false);
  });

  it("allows rgb/rgba/hsl/hsla with numeric args only", () => {
    expect(isSafeCssColor("rgb(0,0,0)")).toBe(true);
    expect(isSafeCssColor("rgba(0, 0, 0, 0.5)")).toBe(true);
    expect(isSafeCssColor("hsl(210, 50%, 40%)")).toBe(true);
    expect(isSafeCssColor("hsla(210 50% 40% / 50%)")).toBe(true);
  });

  it("rejects functions carrying url() / extra declarations / quotes", () => {
    expect(isSafeCssColor("rgb(0,0,0);x:url(/y)")).toBe(false);
    expect(isSafeCssColor("var(--x)")).toBe(false);
    expect(isSafeCssColor("url(https://evil/x)")).toBe(false);
    expect(isSafeCssColor("red")).toBe(false); // named colors not in scope
  });
});

describe("findUnsafeCompositionVar — pass-through", () => {
  it("leaves non-constrained keys (text-content placeholders) alone", () => {
    // These land in HTML text content and are markup-escaped by the template;
    // the validator must not reject them.
    expect(
      findUnsafeCompositionVar({
        "user.headline": 'Quotes "and" <brackets> & ampersands are fine here',
        "capture.url": "https://example.com/<not-a-real-tag>",
        "capture.title": "My <b>Title</b>",
      }),
    ).toBeNull();
  });

  it("ignores non-string and empty values", () => {
    expect(
      findUnsafeCompositionVar({
        "brand.logoUrl": "",
        "brand.primaryColor": 123 as unknown as string,
      }),
    ).toBeNull();
  });

  it("returns null for null / undefined maps", () => {
    expect(findUnsafeCompositionVar(null)).toBeNull();
    expect(findUnsafeCompositionVar(undefined)).toBeNull();
  });
});

describe("assertSafeCompositionVars", () => {
  it("throws UnsafeCompositionVarError on the first violation", () => {
    expect(() =>
      assertSafeCompositionVars({
        "brand.logoUrl": 'https://x/y.png" onerror="alert(1)',
      }),
    ).toThrow(UnsafeCompositionVarError);
  });

  it("does not throw for a safe map", () => {
    expect(() =>
      assertSafeCompositionVars({
        "brand.logoUrl": "https://cdn.example.com/logo.png",
        "brand.primaryColor": "#6366f1",
      }),
    ).not.toThrow();
  });
});
