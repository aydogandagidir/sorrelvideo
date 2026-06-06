import type {
  SuggestInput,
  SuggestResult,
  ExtractBrandInput,
  ExtractBrandResult,
  GenerateVideoIdeasInput,
  GenerateVideoIdeasResult,
} from "../schema";

export interface AiProvider {
  readonly name: "anthropic" | "openai";
  /** Generate Studio copy (headline/body/cta) from a brief + brand DNA. */
  suggest(input: SuggestInput): Promise<SuggestResult>;
  /**
   * Refine scraped website signals (+ an optional screenshot) into a brand DNA:
   * visual identity (name, colors, font) + narrative identity (tagline,
   * description, value prop, audience, keywords, personality, image style). The
   * caller (brandExtractionService) falls back to a deterministic heuristic if
   * this throws — so a provider outage degrades, it does not break.
   */
  extractBrand(input: ExtractBrandInput): Promise<ExtractBrandResult>;
  /**
   * Turn a brand DNA into a handful of ready-to-render short-video concepts
   * (Pomelli's "campaign ideas" step, adapted to Sorrel video projects).
   */
  generateVideoIdeas(
    input: GenerateVideoIdeasInput,
  ): Promise<GenerateVideoIdeasResult>;
}
