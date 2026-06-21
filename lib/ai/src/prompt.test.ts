import { describe, expect, it } from "vitest";
import {
  SYSTEM_CORE,
  buildBrandContext,
  buildSystemPrompt,
  buildUserPrompt,
  buildAvatarSystem,
  buildVideoIdeasUserText,
  PICK_SECTIONS_SYSTEM,
  buildPickSectionsUserText,
} from "./prompt";

const EMPTY_BRAND = {
  companyName: null,
  voice: null,
  voiceDescription: null,
} as const;

describe("buildAvatarSystem", () => {
  it("names the brand + demands short, plain spoken text", () => {
    const sys = buildAvatarSystem({
      ...EMPTY_BRAND,
      companyName: "Acme",
      description: "CI tooling",
    });
    expect(sys).toContain("Acme");
    expect(sys).toMatch(/spoken|out loud/i);
    expect(sys).toMatch(/no markdown/i);
    expect(sys).toContain("What they do: CI tooling"); // brand context folded in
  });

  it("works without a brand (generic host, no leaked null)", () => {
    const sys = buildAvatarSystem(EMPTY_BRAND);
    expect(sys).toMatch(/friendly AI host/i);
    expect(sys).not.toContain("null");
  });
});

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

  it("keeps the plain brief form when no current copy is supplied", () => {
    expect(buildUserPrompt("hello world")).toBe("Brief: hello world");
  });

  it("frames an EDIT turn when current copy is supplied", () => {
    const out = buildUserPrompt("make it punchier", {
      headline: "Old headline",
      bodyText: "Old body",
      ctaText: "Buy now",
    });
    // A revise instruction, not a from-scratch brief…
    expect(out).not.toContain("Brief:");
    expect(out).toMatch(/Revise the CURRENT video copy/i);
    expect(out).toContain("Instruction: make it punchier");
    // …with the current copy JSON-embedded so the model can't confuse it with
    // the instruction (and a quote/newline inside a field can't break framing).
    expect(out).toContain('"headline": "Old headline"');
    expect(out).toContain('"bodyText": "Old body"');
    expect(out).toContain('"ctaText": "Buy now"');
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

  it("grounds copy in the richer Brand DNA fields when present", () => {
    const ctx = buildBrandContext({
      companyName: "Acme",
      tagline: "Ship faster",
      description: "Acme builds CI tooling.",
      valueProposition: "Cut build times in half.",
      targetAudience: "platform engineers",
      keywords: ["ci", "devtools"],
      personality: ["bold", "precise"],
      voice: "bold",
      voiceDescription: null,
    });
    expect(ctx).toContain("Value proposition: Cut build times in half.");
    expect(ctx).toContain("Target audience: platform engineers");
    expect(ctx).toContain("Themes / keywords: ci, devtools");
    expect(ctx).toContain("Brand personality: bold, precise");
  });
});

describe("buildVideoIdeasUserText", () => {
  it("asks for N ideas and embeds the DNA", () => {
    const text = buildVideoIdeasUserText({
      dna: {
        companyName: "Acme",
        description: "CI tooling",
        valueProposition: "Faster builds",
        targetAudience: null,
        keywords: ["ci"],
        personality: ["bold"],
        voice: "bold",
        voiceDescription: null,
      },
      count: 3,
    });
    expect(text).toContain("Propose 3 distinct short-video concepts");
    expect(text).toContain("Acme");
    expect(text).toContain("Faster builds");
  });
});

describe("buildPickSectionsUserText", () => {
  it("indexes the candidate sections and embeds the prompt + title", () => {
    const text = buildPickSectionsUserText({
      prompt: "feature our AI products and the contact form",
      title: "Acme",
      sections: [
        { label: "Hero" },
        { label: "AI products" },
        { label: "Contact" },
      ],
    });
    expect(text).toContain("feature our AI products");
    expect(text).toContain("Page title: Acme");
    // Indexed list so the model can reference sections by number.
    expect(text).toContain("0: Hero");
    expect(text).toContain("1: AI products");
    expect(text).toContain("2: Contact");
  });
});

describe("PICK_SECTIONS_SYSTEM (the cacheable director prompt)", () => {
  it("states the index/seconds/caption contract + JSON-only output", () => {
    expect(PICK_SECTIONS_SYSTEM).toContain('"index"');
    expect(PICK_SECTIONS_SYSTEM).toContain('"seconds"');
    expect(PICK_SECTIONS_SYSTEM).toContain('"caption"');
    expect(PICK_SECTIONS_SYSTEM).toMatch(/ONLY the JSON object/i);
  });
});
