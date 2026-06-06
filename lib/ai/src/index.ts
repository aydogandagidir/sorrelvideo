import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";
import type { AiProvider } from "./providers/types";

export {
  BrandVoiceSchema,
  BrandDnaSchema,
  SuggestInputSchema,
  SuggestOutputSchema,
  ExtractBrandInputSchema,
  ExtractBrandOutputSchema,
  ExtractBrandSignalsSchema,
  BrandScreenshotSchema,
  VideoIdeaSchema,
  VideoIdeaModuleSchema,
  GenerateVideoIdeasInputSchema,
  GenerateVideoIdeasOutputSchema,
  type BrandVoice,
  type BrandDna,
  type SuggestInput,
  type SuggestOutput,
  type SuggestResult,
  type SuggestUsage,
  type ExtractBrandInput,
  type ExtractBrandOutput,
  type ExtractBrandResult,
  type ExtractBrandSignals,
  type BrandSignalColor,
  type BrandScreenshot,
  type VideoIdea,
  type VideoIdeaModule,
  type GenerateVideoIdeasInput,
  type GenerateVideoIdeasResult,
} from "./schema";
export { buildSystemPrompt, buildUserPrompt } from "./prompt";
export type { AiProvider };

/**
 * Pick an AI provider based on the `AI_PROVIDER` env var. Defaults to
 * `anthropic`. Callers should hold the result for a single request — the
 * underlying SDK clients are lazy singletons.
 */
export function getProvider(): AiProvider {
  const choice = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  switch (choice) {
    case "anthropic":
      return anthropicProvider;
    case "openai":
      return openaiProvider;
    default:
      throw new Error(
        `Unknown AI_PROVIDER='${choice}'. Expected 'anthropic' or 'openai'.`,
      );
  }
}
