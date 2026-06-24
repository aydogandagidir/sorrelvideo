import { z } from "zod";

/** Voice slugs we let the user pick on the Brand page. */
export const BrandVoiceSchema = z.enum([
  "professional",
  "playful",
  "bold",
  "minimal",
]);
export type BrandVoice = z.infer<typeof BrandVoiceSchema>;

/** The Brand DNA context shared by the copy suggester + the video-idea generator. */
export const BrandDnaSchema = z.object({
  companyName: z.string().nullable(),
  tagline: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  valueProposition: z.string().nullable().optional(),
  targetAudience: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  personality: z.array(z.string()).nullable().optional(),
  voice: BrandVoiceSchema.nullable(),
  voiceDescription: z.string().max(500).nullable(),
});
export type BrandDna = z.infer<typeof BrandDnaSchema>;

/**
 * The current Studio copy, supplied when `prompt` is an EDIT instruction (the
 * "Edit with AI" flow) instead of a from-scratch brief. Fields may be empty —
 * the user can be refining a partial draft — so unlike `SuggestOutputSchema`
 * these are not `.min(1)`. Same per-field length caps as the output.
 */
export const CurrentCopySchema = z.object({
  headline: z.string().max(160),
  bodyText: z.string().max(500),
  ctaText: z.string().max(48),
});
export type CurrentCopy = z.infer<typeof CurrentCopySchema>;

/** What the API route hands to the provider. */
export const SuggestInputSchema = z.object({
  prompt: z.string().min(3).max(500),
  brand: BrandDnaSchema,
  /**
   * When present, `prompt` is an EDIT instruction applied to this current copy
   * ("Edit with AI") rather than a from-scratch brief. The provider frames the
   * turn as a minimal revision that keeps fields the instruction doesn't touch.
   */
  current: CurrentCopySchema.optional(),
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

// ─────────────────────────── Live Avatar chat ───────────────────────────────
// A free, browser-native conversational avatar (Track F, self-hosted path): the
// browser does speech-to-text + text-to-speech for free; this is the LLM turn in
// the middle, voiced in the user's brand. Replies are SHORT (spoken aloud) and
// plain text (never markdown).

/** One conversation turn. `system` turns are server-built, never client-sent. */
export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatInputSchema = z.object({
  /** Prior turns + the latest user turn (last). Bounded so a client can't blow context. */
  messages: z.array(ChatMessageSchema).min(1).max(40),
  brand: BrandDnaSchema,
  maxTokens: z.number().int().positive().max(1000).optional(),
});
export type ChatInput = z.infer<typeof ChatInputSchema>;

export interface ChatResult {
  /** The assistant's plain-text reply, ready to speak. */
  reply: string;
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
  /** Visible page copy (headings + hero/lead paragraphs) for narrative DNA synthesis. */
  textSample: z.string().default(""),
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
  // ── Brand DNA (narrative identity) ──
  tagline: z.string().max(140).nullable(),
  description: z.string().max(400).nullable(),
  valueProposition: z.string().max(280).nullable(),
  targetAudience: z.string().max(280).nullable(),
  industry: z.string().max(80).nullable(),
  keywords: z.array(z.string().max(40)).max(12),
  personality: z.array(z.string().max(40)).max(8),
  imageStyle: z.string().max(280).nullable(),
});
export type ExtractBrandOutput = z.infer<typeof ExtractBrandOutputSchema>;

export interface ExtractBrandResult extends ExtractBrandOutput {
  usage: SuggestUsage;
}

// ───────────────────────────── Video ideas from DNA ─────────────────────────
// Pomelli's "campaign ideas" step, adapted to Sorrel: turn the Brand DNA into a
// handful of ready-to-render video concepts the user can one-click into a project.

/** The composition modules a video idea may target (kept in sync with renderService). */
export const VideoIdeaModuleSchema = z.enum([
  "product-launch",
  "brand-promo",
  "social-teaser",
  "studio",
]);
export type VideoIdeaModule = z.infer<typeof VideoIdeaModuleSchema>;

export const VideoIdeaSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  module: VideoIdeaModuleSchema,
  headline: z.string().min(1).max(160),
  bodyText: z.string().min(1).max(500),
  ctaText: z.string().min(1).max(48),
});
export type VideoIdea = z.infer<typeof VideoIdeaSchema>;

export const GenerateVideoIdeasInputSchema = z.object({
  dna: BrandDnaSchema,
  count: z.number().int().min(1).max(6).default(4),
  maxTokens: z.number().int().positive().max(3000).optional(),
});
export type GenerateVideoIdeasInput = z.infer<
  typeof GenerateVideoIdeasInputSchema
>;

export const GenerateVideoIdeasOutputSchema = z.object({
  ideas: z.array(VideoIdeaSchema).max(6),
});
export type GenerateVideoIdeasOutput = z.infer<
  typeof GenerateVideoIdeasOutputSchema
>;

export interface GenerateVideoIdeasResult extends GenerateVideoIdeasOutput {
  usage: SuggestUsage;
}

// ───────────────────────── Website→Video section picker ─────────────────────
// The "describe your video" mode for website→video. Given the candidate sections
// a page scraper found (a short label per block) and the user's free-text
// description, the model picks WHICH sections to feature, in what ORDER, how long
// to hold each, and a short caption — turning a dumb full-page scroll into a
// curated, user-directed highlight tour. The caller maps the returned indexes
// back to server-computed crops, so the model never emits geometry.

/** A candidate section the page scraper found (index = position in the array). */
export const SectionCandidateSchema = z.object({
  label: z.string().max(200),
});
export type SectionCandidate = z.infer<typeof SectionCandidateSchema>;

export const PickSectionsInputSchema = z.object({
  /** The user's free-text description of the video they want. */
  prompt: z.string().min(1).max(800),
  /** Page title, for context. */
  title: z.string().default(""),
  /** Candidate sections; the model references them by array index. */
  sections: z.array(SectionCandidateSchema).min(1).max(40),
  maxTokens: z.number().int().positive().max(1500).optional(),
});
export type PickSectionsInput = z.infer<typeof PickSectionsInputSchema>;

/** One featured beat of the tour: which candidate, how long, optional caption. */
export const SectionPickSchema = z.object({
  index: z.number().int().min(0),
  seconds: z.number().min(1).max(8),
  caption: z.string().max(48).nullable().optional(),
});
export type SectionPick = z.infer<typeof SectionPickSchema>;

export const PickSectionsOutputSchema = z.object({
  picks: z.array(SectionPickSchema).min(1).max(8),
});
export type PickSectionsOutput = z.infer<typeof PickSectionsOutputSchema>;

export interface PickSectionsResult extends PickSectionsOutput {
  usage: SuggestUsage;
}

// ───────────────────────── Website→Video prompt-refine ──────────────────────
// "Fix it in the preview" for a website→video showcase: a natural-language
// instruction ("make it shorter", "focus on the hero") → a small set of
// presentation knobs the composition already exposes. The model returns only
// BOUNDED scalars/enums, never geometry — the caller clamps the duration and
// maps the region to a server-computed crop (same trust model as pickSections).
// "No change" is explicit ("keep" / 0) so the strict OpenAI json_schema needs no
// nullables.

/** Which part of the captured page to feature. "keep" = leave the crop as-is. */
export const RefineRegionSchema = z.enum([
  "keep",
  "whole",
  "hero",
  "top",
  "bottom",
]);
export type RefineRegion = z.infer<typeof RefineRegionSchema>;

export const RefineWebsiteVideoInputSchema = z.object({
  /** The user's free-text edit instruction (in their own language). */
  instruction: z.string().min(1).max(500),
  current: z.object({
    /** The project's current video length, so the model can reason about it. */
    durationSeconds: z.number(),
    /** Captured page height in px (tall pages read slower). */
    captureHeight: z.number(),
  }),
  maxTokens: z.number().int().positive().max(800).optional(),
});
export type RefineWebsiteVideoInput = z.infer<
  typeof RefineWebsiteVideoInputSchema
>;

export const RefineWebsiteVideoOutputSchema = z.object({
  /** New length in seconds (caller clamps to 3-60); 0 = leave unchanged. */
  duration: z.number(),
  /** Which region to feature, or "keep" to leave the framing unchanged. */
  region: RefineRegionSchema,
  /** One short sentence describing the change, in the instruction's language. */
  note: z.string().max(200),
});
export type RefineWebsiteVideoOutput = z.infer<
  typeof RefineWebsiteVideoOutputSchema
>;

export interface RefineWebsiteVideoResult extends RefineWebsiteVideoOutput {
  usage: SuggestUsage;
}
