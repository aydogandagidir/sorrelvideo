import OpenAI from "openai";
import { buildSystemPrompt, buildUserPrompt } from "../prompt";
import {
  SuggestOutputSchema,
  type SuggestInput,
  type SuggestResult,
} from "../schema";
import type { AiProvider } from "./types";

const DEFAULT_MODEL = "gpt-4o-mini";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set — required when AI_PROVIDER=openai",
      );
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

const SUGGEST_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "bodyText", "ctaText"],
  properties: {
    headline: { type: "string" },
    bodyText: { type: "string" },
    ctaText: { type: "string" },
  },
} as const;

export const openaiProvider: AiProvider = {
  name: "openai",

  async suggest(input: SuggestInput): Promise<SuggestResult> {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    const system = buildSystemPrompt(input.brand);
    const userPrompt = buildUserPrompt(input.prompt);

    const response = await getClient().chat.completions.create({
      model,
      max_tokens: input.maxTokens ?? 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "suggest",
          strict: true,
          schema: SUGGEST_RESPONSE_SCHEMA,
        },
      },
    });

    const choice = response.choices[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new Error("OpenAI returned no message content");
    }

    const parsedJson: unknown = JSON.parse(text);
    const output = SuggestOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        // OpenAI caches prompt prefixes >1024 tokens AUTOMATICALLY (no
        // cache_control knob), reporting reuse here. Surfaced for parity with
        // Anthropic's cache_read; there is no separate cache-creation charge.
        cacheReadInputTokens:
          response.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
      },
    };
  },
};
