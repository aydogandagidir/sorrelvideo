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
 * Compose the system message handed to the LLM. We deliberately keep this
 * stable and treat the user-supplied prompt as separate data so simple
 * prompt-injection attempts ("ignore previous instructions") have nothing
 * to grab onto here.
 */
export function buildSystemPrompt(brand: {
  companyName: string | null;
  voice: BrandVoice | null;
  voiceDescription: string | null;
}): string {
  const parts: string[] = [
    "You write short-form video copy for Sorrel Studio.",
    "",
    "Given a creative brief from the user, return three fields:",
    '- "headline": <= 80 chars, punchy, ideally two short lines (use "\\n" for the break)',
    '- "bodyText": <= 240 chars, one or two sentences expanding the headline',
    '- "ctaText": <= 24 chars, an action phrase ("Try it free", "Get the report", "See how")',
    "",
    "Respond with ONLY a single JSON object containing exactly those three keys.",
    "Do not add commentary, markdown fences, or any other text.",
  ];

  if (brand.companyName) {
    parts.push("", `The brand is ${brand.companyName}.`);
  }
  if (brand.voice) {
    parts.push("", `Voice: ${VOICE_HINTS[brand.voice]}`);
  }
  if (brand.voiceDescription) {
    parts.push(
      "",
      "Additional brand voice notes from the operator:",
      brand.voiceDescription,
    );
  }

  return parts.join("\n");
}

/** Wraps the user's brief in a minimal scaffold; the model already has shape rules from the system prompt. */
export function buildUserPrompt(brief: string): string {
  return `Brief: ${brief.trim()}`;
}
