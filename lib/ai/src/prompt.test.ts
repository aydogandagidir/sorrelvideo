import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

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
