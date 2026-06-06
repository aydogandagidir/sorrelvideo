import type {
  SuggestInput,
  SuggestResult,
  ExtractBrandInput,
  ExtractBrandResult,
} from "../schema";

export interface AiProvider {
  readonly name: "anthropic" | "openai";
  /** Generate Studio copy (headline/body/cta) from a brief + brand voice. */
  suggest(input: SuggestInput): Promise<SuggestResult>;
  /**
   * Refine scraped website signals (+ an optional screenshot) into a canonical
   * brand kit: company name, primary/secondary/accent colors, and the UI font.
   * The caller (brandExtractionService) falls back to a deterministic heuristic
   * if this throws — so a provider outage degrades, it does not break.
   */
  extractBrand(input: ExtractBrandInput): Promise<ExtractBrandResult>;
}
