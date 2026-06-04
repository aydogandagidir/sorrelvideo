import type { BrandVoice } from "./schema";

const VOICE_HINTS: Record<BrandVoice, string> = {
  professional:
    "Confident and clear. Treat the reader as a peer. Avoid jargon and hype.",
  playful:
    "Warm and a little witty. Short sentences. Light wordplay where it fits, never forced.",
  bold: "Direct, opinionated, energetic. Strong verbs. Short rhythm. Make a point.",
  minimal: "Sparse. Concrete nouns. No adverbs. Every word earns its place.",
};

/**
 * The STABLE, brand-independent half of the system prompt: the task framing and
 * output contract. Identical for every user and every request, so it is the
 * natural prompt-cache prefix — `anthropicProvider` marks it with a
 * `cache_control` breakpoint so it is shared across requests (and across users)
 * within the cache TTL. Keep it free of any per-user data so that sharing holds.
 *
 * NOTE: prompt caching only *engages* once the cached prefix clears the model's
 * minimum cacheable length (≈1024 tokens for Sonnet/Opus, ≈2048 for Haiku). This
 * core is far smaller today, so the structure is correct but inert until the
 * shared context grows (e.g. few-shot examples / longer guidelines). See the
 * provider + README caveats.
 */
export const SYSTEM_CORE: string = [
  "You write short-form video copy for Sorrel Studio.",
  "",
  "Given a creative brief from the user, return three fields:",
  '- "headline": <= 80 chars, punchy, ideally two short lines (use "\\n" for the break)',
  '- "bodyText": <= 240 chars, one or two sentences expanding the headline',
  '- "ctaText": <= 24 chars, an action phrase ("Try it free", "Get the report", "See how")',
  "",
  "Respond with ONLY a single JSON object containing exactly those three keys.",
  "Do not add commentary, markdown fences, or any other text.",
].join("\n");

/**
 * The VARIABLE, per-brand half of the system context (company name + canonical
 * voice + free-text notes). Stable for a given brand across that user's
 * requests, so the provider gives it its own `cache_control` breakpoint — a
 * user iterating on suggestions reuses the whole system prefix; only the user
 * brief changes. Returns `null` when the brand kit carries no voice signal, so
 * no empty block is emitted.
 */
export function buildBrandContext(brand: {
  companyName: string | null;
  voice: BrandVoice | null;
  voiceDescription: string | null;
}): string | null {
  const parts: string[] = [];

  if (brand.companyName) {
    parts.push(`The brand is ${brand.companyName}.`);
  }
  if (brand.voice) {
    parts.push(`Voice: ${VOICE_HINTS[brand.voice]}`);
  }
  if (brand.voiceDescription) {
    parts.push(
      "Additional brand voice notes from the operator:",
      brand.voiceDescription,
    );
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Compose the full system message as a single string (core + brand context). We
 * deliberately keep this stable and treat the user-supplied prompt as separate
 * data so simple prompt-injection attempts ("ignore previous instructions") have
 * nothing to grab onto here.
 *
 * Kept for the providers that take a plain string system (OpenAI, which caches
 * automatically). `anthropicProvider` instead consumes `SYSTEM_CORE` +
 * `buildBrandContext` as separate, individually cache-controlled blocks.
 */
export function buildSystemPrompt(brand: {
  companyName: string | null;
  voice: BrandVoice | null;
  voiceDescription: string | null;
}): string {
  const brandContext = buildBrandContext(brand);
  return brandContext ? `${SYSTEM_CORE}\n\n${brandContext}` : SYSTEM_CORE;
}

/** Wraps the user's brief in a minimal scaffold; the model already has shape rules from the system prompt. */
export function buildUserPrompt(brief: string): string {
  return `Brief: ${brief.trim()}`;
}
