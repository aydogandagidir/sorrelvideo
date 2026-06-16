import OpenAI from "openai";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildAvatarSystem,
  BRAND_EXTRACT_SYSTEM,
  buildBrandExtractUserText,
  VIDEO_IDEAS_SYSTEM,
  buildVideoIdeasUserText,
} from "../prompt";
import {
  SuggestOutputSchema,
  ExtractBrandOutputSchema,
  GenerateVideoIdeasOutputSchema,
  type SuggestInput,
  type SuggestResult,
  type ExtractBrandInput,
  type ExtractBrandResult,
  type GenerateVideoIdeasInput,
  type GenerateVideoIdeasResult,
  type ChatInput,
  type ChatResult,
} from "../schema";
import type { AiProvider } from "./types";

const DEFAULT_MODEL = "gpt-4o-mini";

// gpt-5-family models reject the legacy `max_tokens` on chat.completions and
// require `max_completion_tokens`; the newer name is also accepted by gpt-4o
// models, so we use it unconditionally. These caps include any hidden reasoning
// tokens, so they're set generously (cost is billed by ACTUAL usage, not the
// cap) — a tight cap can be fully consumed by reasoning and yield empty content.
// `store: true` matches OpenAI's free-tier example (Responses/quickstart) and is
// harmless on paid usage.
const TOKENS = {
  suggest: 2048,
  extractBrand: 2048,
  videoIdeas: 4096,
  chat: 600,
} as const;

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

const EXTRACT_BRAND_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "companyName",
    "primaryColor",
    "secondaryColor",
    "accentColor",
    "fontFamily",
    "tagline",
    "description",
    "valueProposition",
    "targetAudience",
    "industry",
    "keywords",
    "personality",
    "imageStyle",
  ],
  properties: {
    companyName: { type: ["string", "null"] },
    primaryColor: { type: "string" },
    secondaryColor: { type: "string" },
    accentColor: { type: ["string", "null"] },
    fontFamily: { type: ["string", "null"] },
    tagline: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    valueProposition: { type: ["string", "null"] },
    targetAudience: { type: ["string", "null"] },
    industry: { type: ["string", "null"] },
    keywords: { type: "array", items: { type: "string" } },
    personality: { type: "array", items: { type: "string" } },
    imageStyle: { type: ["string", "null"] },
  },
} as const;

const VIDEO_IDEAS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "description",
          "module",
          "headline",
          "bodyText",
          "ctaText",
        ],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          module: {
            type: "string",
            enum: ["product-launch", "brand-promo", "social-teaser", "studio"],
          },
          headline: { type: "string" },
          bodyText: { type: "string" },
          ctaText: { type: "string" },
        },
      },
    },
  },
} as const;

export const openaiProvider: AiProvider = {
  name: "openai",

  async chat(input: ChatInput): Promise<ChatResult> {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    const response = await getClient().chat.completions.create({
      model,
      max_completion_tokens: input.maxTokens ?? TOKENS.chat,
      store: true,
      messages: [
        { role: "system", content: buildAvatarSystem(input.brand) },
        ...input.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    const reply = response.choices[0]?.message?.content?.trim();
    if (!reply) throw new Error("OpenAI returned no message content");

    return {
      reply,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadInputTokens:
          response.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
      },
    };
  },

  async suggest(input: SuggestInput): Promise<SuggestResult> {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    const system = buildSystemPrompt(input.brand);
    const userPrompt = buildUserPrompt(input.prompt, input.current);

    const response = await getClient().chat.completions.create({
      model,
      max_completion_tokens: input.maxTokens ?? TOKENS.suggest,
      store: true,
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

  async extractBrand(input: ExtractBrandInput): Promise<ExtractBrandResult> {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: buildBrandExtractUserText(input.signals) },
    ];
    if (input.screenshot) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${input.screenshot.mediaType};base64,${input.screenshot.base64}`,
        },
      });
    }

    const response = await getClient().chat.completions.create({
      model,
      max_completion_tokens: input.maxTokens ?? TOKENS.extractBrand,
      store: true,
      messages: [
        { role: "system", content: BRAND_EXTRACT_SYSTEM },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "extract_brand",
          strict: true,
          schema: EXTRACT_BRAND_RESPONSE_SCHEMA,
        },
      },
    });

    const choice = response.choices[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new Error("OpenAI returned no message content");
    }

    const parsedJson: unknown = JSON.parse(text);
    const output = ExtractBrandOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadInputTokens:
          response.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
      },
    };
  },

  async generateVideoIdeas(
    input: GenerateVideoIdeasInput,
  ): Promise<GenerateVideoIdeasResult> {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

    const response = await getClient().chat.completions.create({
      model,
      max_completion_tokens: input.maxTokens ?? TOKENS.videoIdeas,
      store: true,
      messages: [
        { role: "system", content: VIDEO_IDEAS_SYSTEM },
        { role: "user", content: buildVideoIdeasUserText(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "video_ideas",
          strict: true,
          schema: VIDEO_IDEAS_RESPONSE_SCHEMA,
        },
      },
    });

    const choice = response.choices[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new Error("OpenAI returned no message content");
    }

    const parsedJson: unknown = JSON.parse(text);
    const output = GenerateVideoIdeasOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadInputTokens:
          response.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
      },
    };
  },
};
