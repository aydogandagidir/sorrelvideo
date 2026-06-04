import { describe, expect, it } from "vitest";
import {
  SYSTEM_CORE,
  buildBrandContext,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt";

describe("buildSystemPrompt", () => {
  it("returns the base scaffold when no brand info is supplied", () => {
    const out = buildSystemPrompt({
      companyName: null,
      voice: null,
      voiceDescription: null,
    });
    expect(out).toContain("Sorrel Studio");
    expect(out).toContain('"headline"');
    expect(out).toContain('"bodyText"');
    expect(out).toContain('"ctaText"');
    expect(out).not.toContain("The brand is");
    expect(out).not.toContain("Voice:");
  });

  it("injects the company name when provided", () => {
    const out = buildSystemPrompt({
      companyName: "Acme",
      voice: null,
      voiceDescription: null,
    });
    expect(out).toContain("The brand is Acme.");
  });

  it("includes the canonical voice hint when a brandVoice is set", () => {
    const out = buildSystemPrompt({
      companyName: null,
      voice: "bold",
      voiceDescription: null,
    });
    expect(out).toMatch(/Voice:.*Direct/);
  });

  it("appends free-text voice notes when provided", () => {
    const out = buildSystemPrompt({
      companyName: null,
      voice: null,
      voiceDescription: "We never use exclamation marks.",
    });
    expect(out).toContain("We never use exclamation marks.");
  });
});

describe("buildUserPrompt", () => {
  it("prefixes the brief and trims surrounding whitespace", () => {
    expect(buildUserPrompt("  launch our autumn line  ")).toBe(
      "Brief: launch our autumn line",
    );
  });
});

describe("SYSTEM_CORE (the cacheable, brand-independent prefix)", () => {
  it("carries the task framing + output contract", () => {
    expect(SYSTEM_CORE).toContain("Sorrel Studio");
    expect(SYSTEM_CORE).toContain('"headline"');
    expect(SYSTEM_CORE).toContain('"bodyText"');
    expect(SYSTEM_CORE).toContain('"ctaText"');
  });

  it("contains NO per-brand data, so it can be shared across users", () => {
    // The whole point of the cache breakpoint: the core must be byte-identical
    // regardless of brand. Any brand leakage here breaks cross-user cache hits.
    expect(SYSTEM_CORE).not.toContain("The brand is");
    expect(SYSTEM_CORE).not.toContain("Voice:");
    expect(SYSTEM_CORE).not.toContain("brand voice notes");
  });
});

describe("buildBrandContext (the per-brand cache block)", () => {
  it("returns null when the brand kit carries no voice signal", () => {
    expect(
      buildBrandContext({
        companyName: null,
        voice: null,
        voiceDescription: null,
      }),
    ).toBeNull();
  });

  it("includes company, canonical voice, and free-text notes when set", () => {
    const ctx = buildBrandContext({
      companyName: "Acme",
      voice: "bold",
      voiceDescription: "We never use exclamation marks.",
    });
    expect(ctx).toContain("The brand is Acme.");
    expect(ctx).toMatch(/Voice:.*Direct/);
    expect(ctx).toContain("We never use exclamation marks.");
  });

  it("composes into buildSystemPrompt after the core", () => {
    const brand = {
      companyName: "Acme",
      voice: "minimal" as const,
      voiceDescription: null,
    };
    const full = buildSystemPrompt(brand);
    const ctx = buildBrandContext(brand);
    expect(full.startsWith(SYSTEM_CORE)).toBe(true);
    expect(ctx).not.toBeNull();
    expect(full).toContain(ctx as string);
  });
});
