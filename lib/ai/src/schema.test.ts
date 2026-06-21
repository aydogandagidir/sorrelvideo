import { describe, expect, it } from "vitest";
import {
  BrandVoiceSchema,
  CurrentCopySchema,
  SuggestInputSchema,
  SuggestOutputSchema,
  PickSectionsInputSchema,
  PickSectionsOutputSchema,
} from "./schema";

describe("BrandVoiceSchema", () => {
  it("accepts the four canonical slugs", () => {
    for (const v of ["professional", "playful", "bold", "minimal"]) {
      expect(() => BrandVoiceSchema.parse(v)).not.toThrow();
    }
  });

  it("rejects an unknown slug", () => {
    expect(() => BrandVoiceSchema.parse("snarky")).toThrow();
  });
});

describe("SuggestInputSchema", () => {
  it("requires a prompt of at least 3 characters", () => {
    expect(() =>
      SuggestInputSchema.parse({
        prompt: "hi",
        brand: { companyName: null, voice: null, voiceDescription: null },
      }),
    ).toThrow();
  });

  it("caps the prompt at 500 characters", () => {
    expect(() =>
      SuggestInputSchema.parse({
        prompt: "x".repeat(501),
        brand: { companyName: null, voice: null, voiceDescription: null },
      }),
    ).toThrow();
  });

  it("accepts a well-formed input with optional brand", () => {
    const ok = SuggestInputSchema.parse({
      prompt: "launch our autumn line",
      brand: {
        companyName: "Acme",
        voice: "playful",
        voiceDescription: "Use plural pronouns.",
      },
    });
    expect(ok.brand.voice).toBe("playful");
  });

  it("treats `current` as optional (absent → undefined)", () => {
    const ok = SuggestInputSchema.parse({
      prompt: "launch our autumn line",
      brand: { companyName: null, voice: null, voiceDescription: null },
    });
    expect(ok.current).toBeUndefined();
  });

  it("accepts a `current` copy (the edit flow)", () => {
    const ok = SuggestInputSchema.parse({
      prompt: "make it punchier",
      brand: { companyName: null, voice: null, voiceDescription: null },
      current: { headline: "H", bodyText: "B", ctaText: "C" },
    });
    expect(ok.current?.headline).toBe("H");
  });
});

describe("CurrentCopySchema", () => {
  it("allows empty fields (a partial draft being edited)", () => {
    expect(() =>
      CurrentCopySchema.parse({ headline: "", bodyText: "", ctaText: "" }),
    ).not.toThrow();
  });

  it("caps each field at its length limit", () => {
    expect(() =>
      CurrentCopySchema.parse({
        headline: "x".repeat(161),
        bodyText: "y",
        ctaText: "z",
      }),
    ).toThrow();
  });
});

describe("SuggestOutputSchema", () => {
  it("accepts a valid suggestion", () => {
    expect(() =>
      SuggestOutputSchema.parse({
        headline: "Big news",
        bodyText: "Today we are shipping the thing.",
        ctaText: "Read more",
      }),
    ).not.toThrow();
  });

  it("rejects missing keys", () => {
    expect(() =>
      SuggestOutputSchema.parse({
        headline: "x",
        bodyText: "y",
      }),
    ).toThrow();
  });

  it("rejects oversized fields", () => {
    expect(() =>
      SuggestOutputSchema.parse({
        headline: "x".repeat(200),
        bodyText: "y",
        ctaText: "z",
      }),
    ).toThrow();
  });
});

describe("PickSectionsInputSchema", () => {
  it("requires a prompt and at least one section", () => {
    expect(() =>
      PickSectionsInputSchema.parse({ prompt: "", sections: [] }),
    ).toThrow();
  });

  it("accepts a well-formed input", () => {
    const ok = PickSectionsInputSchema.parse({
      prompt: "show the hero and the contact section",
      title: "Acme",
      sections: [{ label: "Hero" }, { label: "Contact" }],
    });
    expect(ok.sections).toHaveLength(2);
    expect(ok.title).toBe("Acme");
  });
});

describe("PickSectionsOutputSchema", () => {
  it("accepts ordered picks with seconds + an optional caption", () => {
    expect(() =>
      PickSectionsOutputSchema.parse({
        picks: [
          { index: 0, seconds: 3, caption: "Welcome" },
          { index: 2, seconds: 2, caption: null },
          { index: 1, seconds: 1.5 },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an empty picks array", () => {
    expect(() => PickSectionsOutputSchema.parse({ picks: [] })).toThrow();
  });

  it("rejects seconds out of range", () => {
    expect(() =>
      PickSectionsOutputSchema.parse({ picks: [{ index: 0, seconds: 99 }] }),
    ).toThrow();
  });
});
