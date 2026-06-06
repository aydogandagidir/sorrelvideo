import { z } from "zod";

/** Voice slugs we let the user pick on the Brand page. */
export const BrandVoiceSchema = z.enum([
  "professional",
  "playful",
  "bold",
  "minimal",
]);
export type BrandVoice = z.infer<typeof BrandVoiceSchema>;

/** What the API route hands to the provider. */
export const SuggestInputSchema = z.object({
  prompt: z.string().min(3).max(500),
  brand: z.object({
    companyName: z.string().nullable(),
    voice: BrandVoiceSchema.nullable(),
    voiceDescription: z.string().max(500).nullable(),
  }),
  maxTokens: z.number().int().positive().max(2000).optional(),
});
export type SuggestInput = z.infer<typeof SuggestInputSchema>;

/** What the provider must hand back. Caller (route) parses against this. */
export const SuggestOutputSchema = z.object({
  headline: z.string().min(1).max(160),
  bodyText: z.string().min(1).max(500),
  ctaText: z.string().min(1).max(48),
});
export type SuggestOutput = z.infer<typeof SuggestOutputSchema>;

export interface SuggestUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens written to the prompt cache on this call — Anthropic's
   * `cache_creation_input_tokens` (a one-time 25% surcharge for the first call
   * that populates a breakpoint). Omitted when caching did not engage or the
   * provider does not report it (e.g. OpenAI, which caches implicitly).
   */
  cacheCreationInputTokens?: number;
  /**
   * Tokens served FROM the prompt cache on this call — Anthropic's
   * `cache_read_input_tokens` (billed at ~10% of the base input rate) or
   * OpenAI's `prompt_tokens_details.cached_tokens`. `> 0` ⇒ a cache hit.
   */
  cacheReadInputTokens?: number;
}

export interface SuggestResult extends SuggestOutput {
  usage: SuggestUsage;
}

// ───────────────────────────── Brand extraction ─────────────────────────────
// Refine raw signals scraped from a website (CSS colors, fonts, logo, meta) plus
// a screenshot into a canonical brand kit. The deterministic DOM scrape happens
// server-side (brandExtractionService); this provider step is the "designer's
// eye" that decides which color is the PRIMARY brand color, names the company,
// and picks the headline font — the part a flat heuristic gets wrong.

/** A single colour the scraper observed on the page, with where it came from. */
export const BrandSignalColorSchema = z.object({
  /** A 6-digit hex (#rrggbb); the scraper normalises rgb()/shorthand to this. */
  hex: z.string(),
  /** Provenance: "theme-color", "--primary", "cta", "link", "header", "heading", "logo", "background", … */
  source: z.string(),
  /** Rough prominence (0–1: area share or normalised frequency). Higher = more dominant. */
  weight: z.number().optional(),
});
export type BrandSignalColor = z.infer<typeof BrandSignalColorSchema>;

/** The raw, deterministic signals the DOM scraper feeds the provider. */
export const ExtractBrandSignalsSchema = z.object({
  url: z.string(),
  title: z.string().default(""),
  siteName: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  themeColor: z.string().nullable().default(null),
  colors: z.array(BrandSignalColorSchema).default([]),
  fontFamilies: z.array(z.string()).default([]),
  logoCandidates: z.array(z.string()).default([]),
});
export type ExtractBrandSignals = z.infer<typeof ExtractBrandSignalsSchema>;

/** An optional screenshot the provider can look at (Claude/OpenAI vision). */
export const BrandScreenshotSchema = z.object({
  base64: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});
export type BrandScreenshot = z.infer<typeof BrandScreenshotSchema>;

export const ExtractBrandInputSchema = z.object({
  signals: ExtractBrandSignalsSchema,
  screenshot: BrandScreenshotSchema.optional(),
  maxTokens: z.number().int().positive().max(2000).optional(),
});
export type ExtractBrandInput = z.infer<typeof ExtractBrandInputSchema>;

/** A strict 6-digit hex — the only colour shape the provider may return. */
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** What the provider must hand back — validated by the caller before it is trusted. */
export const ExtractBrandOutputSchema = z.object({
  /** The brand / product name (not a tagline). Null when the page gives no clear name. */
  companyName: z.string().min(1).max(120).nullable(),
  primaryColor: z.string().regex(HEX6),
  secondaryColor: z.string().regex(HEX6),
  accentColor: z.string().regex(HEX6).nullable(),
  /** The primary UI font FAMILY name only ("Inter"), no fallback stack. Null = unknown. */
  fontFamily: z.string().min(1).max(80).nullable(),
});
export type ExtractBrandOutput = z.infer<typeof ExtractBrandOutputSchema>;

export interface ExtractBrandResult extends ExtractBrandOutput {
  usage: SuggestUsage;
}
