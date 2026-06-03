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
