import type { SuggestInput, SuggestResult } from "../schema";

export interface AiProvider {
  readonly name: "anthropic" | "openai";
  suggest(input: SuggestInput): Promise<SuggestResult>;
}
