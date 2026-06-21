import type {
  SuggestInput,
  SuggestResult,
  ExtractBrandInput,
  ExtractBrandResult,
  GenerateVideoIdeasInput,
  GenerateVideoIdeasResult,
  ChatInput,
  ChatResult,
  PickSectionsInput,
  PickSectionsResult,
} from "../schema";

export interface AiProvider {
  readonly name: "anthropic" | "openai";
  /** Generate Studio copy (headline/body/cta) from a brief + brand DNA. */
  suggest(input: SuggestInput): Promise<SuggestResult>;
  /**
   * A free-form, brand-voiced conversation turn for the Live Avatar (plain-text
   * reply, spoken aloud client-side). Unlike suggest/extract this is NOT JSON.
   */
  chat(input: ChatInput): Promise<ChatResult>;
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
  /**
   * website→video "describe your video" director: given a captured page's
   * candidate sections (labels) + the user's request, pick + order the sections
   * to feature (by index) with a hold time and optional caption per beat. The
   * caller maps indexes back to server-computed crops, so no geometry is trusted
   * from the model.
   */
  pickSections(input: PickSectionsInput): Promise<PickSectionsResult>;
}
