import OpenAI from "openai";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildAvatarSystem,
  BRAND_EXTRACT_SYSTEM,
  buildBrandExtractUserText,
  VIDEO_IDEAS_SYSTEM,
  buildVideoIdeasUserText,
  PICK_SECTIONS_SYSTEM,
  buildPickSectionsUserText,
  REFINE_VIDEO_SYSTEM,
  buildRefineVideoUserText,
  JUDGE_TOURS_SYSTEM,
  buildJudgeToursUserText,
} from "../prompt";
import {
  SuggestOutputSchema,
  ExtractBrandOutputSchema,
  GenerateVideoIdeasOutputSchema,
  PickSectionsOutputSchema,
  RefineWebsiteVideoOutputSchema,
  JudgeToursOutputSchema,
  type SuggestInput,
  type SuggestResult,
  type ExtractBrandInput,
  type ExtractBrandResult,
  type GenerateVideoIdeasInput,
  type GenerateVideoIdeasResult,
  type ChatInput,
  type ChatResult,
  type PickSectionsInput,
  type PickSectionsResult,
  type RefineWebsiteVideoInput,
  type RefineWebsiteVideoResult,
  type JudgeToursInput,
  type JudgeToursResult,
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
  pickSections: 1024,
  refineWebsiteVideo: 400,
  judgeTours: 300,
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

const PICK_SECTIONS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["picks"],
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // OpenAI strict mode requires every property in `required`; `caption`
        // is still nullable, which the Zod `.nullable().optional()` accepts.
        required: ["index", "seconds", "caption"],
        properties: {
          index: { type: "integer" },
          seconds: { type: "number" },
          caption: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

// Strict json_schema for the website→video refine call. All keys required, no
// nullables — "no change" is the explicit "keep" / 0 (see RefineWebsiteVideoOutputSchema).
const REFINE_VIDEO_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["duration", "region", "note"],
  properties: {
    duration: { type: "number" },
    region: {
      type: "string",
      enum: ["keep", "whole", "hero", "top", "bottom"],
    },
    note: { type: "string" },
  },
} as const;

// Strict json_schema for the website→video tour judge — index of the best
// candidate + a one-line reason.
const JUDGE_TOURS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bestIndex", "reason"],
  properties: {
    bestIndex: { type: "integer" },
    reason: { type: "string" },
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

  async pickSections(input: PickSectionsInput): Promise<PickSectionsResult> {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

    const response = await getClient().chat.completions.create({
      model,
      max_completion_tokens: input.maxTokens ?? TOKENS.pickSections,
      store: true,
      messages: [
        { role: "system", content: PICK_SECTIONS_SYSTEM },
        { role: "user", content: buildPickSectionsUserText(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "pick_sections",
          strict: true,
          schema: PICK_SECTIONS_RESPONSE_SCHEMA,
        },
      },
    });

    const choice = response.choices[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new Error("OpenAI returned no message content");
    }

    const parsedJson: unknown = JSON.parse(text);
    const output = PickSectionsOutputSchema.parse(parsedJson);

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

  async refineWebsiteVideo(
    input: RefineWebsiteVideoInput,
  ): Promise<RefineWebsiteVideoResult> {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

    const response = await getClient().chat.completions.create({
      model,
      max_completion_tokens: input.maxTokens ?? TOKENS.refineWebsiteVideo,
      store: true,
      messages: [
        { role: "system", content: REFINE_VIDEO_SYSTEM },
        { role: "user", content: buildRefineVideoUserText(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "refine_video",
          strict: true,
          schema: REFINE_VIDEO_RESPONSE_SCHEMA,
        },
      },
    });

    const choice = response.choices[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new Error("OpenAI returned no message content");
    }

    const parsedJson: unknown = JSON.parse(text);
    const output = RefineWebsiteVideoOutputSchema.parse(parsedJson);

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

  async judgeTours(input: JudgeToursInput): Promise<JudgeToursResult> {
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: buildJudgeToursUserText(input) },
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
      max_completion_tokens: input.maxTokens ?? TOKENS.judgeTours,
      store: true,
      messages: [
        { role: "system", content: JUDGE_TOURS_SYSTEM },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "judge_tours",
          strict: true,
          schema: JUDGE_TOURS_RESPONSE_SCHEMA,
        },
      },
    });

    const choice = response.choices[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new Error("OpenAI returned no message content");
    }

    const parsedJson: unknown = JSON.parse(text);
    const output = JudgeToursOutputSchema.parse(parsedJson);

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
