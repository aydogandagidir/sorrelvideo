import type { BrandVoice, ExtractBrandSignals } from "./schema";

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

// ───────────────────────────── Brand extraction ─────────────────────────────

/**
 * Stable system prompt for the "look at a website and name its brand kit" task.
 * Brand-independent and identical every call → the natural prompt-cache prefix
 * (anthropicProvider marks it cache_control). Keep it free of per-site data.
 */
export const BRAND_EXTRACT_SYSTEM: string = [
  "You are a senior brand designer. Given signals scraped from a website (and a",
  "screenshot when provided), identify the site's brand kit.",
  "",
  "Return four things:",
  '- "companyName": the brand or product name a visitor would recognise (NOT a',
  "  tagline, NOT the full <title> with marketing suffixes). Null if unclear.",
  '- "primaryColor": the dominant BRAND color — the one used for primary buttons,',
  "  links and key accents. This is the color a designer would call the brand color.",
  '- "secondaryColor": a complementary base — usually the dark text/surface color',
  "  or a strong supporting brand color. Must visibly differ from primaryColor.",
  '- "accentColor": a tertiary highlight color, or null if the brand is two-color.',
  '- "fontFamily": the primary UI font FAMILY NAME only (e.g. "Inter", "Roboto",',
  '  "Poppins") — no fallback stack, no quotes. Null if you cannot tell.',
  "",
  "Prefer colors the brand actually uses over incidental colors (photos, ads).",
  "Ignore pure white/black/greys as brand colors unless the brand is truly monochrome.",
  "All colors MUST be 6-digit hex like #1a2b3c.",
  "",
  "Respond with ONLY a single JSON object with exactly those five keys.",
  "No commentary, no markdown fences.",
].join("\n");

/**
 * The per-site user text: the scraped signals as compact JSON. The screenshot
 * (when present) is attached by the provider as a separate image block, so a
 * vision model sees both the structured hints and the rendered page.
 */
export function buildBrandExtractUserText(signals: ExtractBrandSignals): string {
  const compact = {
    url: signals.url,
    title: signals.title,
    siteName: signals.siteName,
    description: signals.description,
    themeColor: signals.themeColor,
    // Most-prominent first; the provider weighs these alongside the screenshot.
    colors: signals.colors
      .slice()
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, 24),
    fontFamilies: signals.fontFamilies.slice(0, 8),
    logoCandidates: signals.logoCandidates.slice(0, 6),
  };
  return [
    "Here are the scraped signals for the website. Use them together with the",
    "screenshot (if attached) to decide the brand kit.",
    "",
    JSON.stringify(compact, null, 2),
  ].join("\n");
}
