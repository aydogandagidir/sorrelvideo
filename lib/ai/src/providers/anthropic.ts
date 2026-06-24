import Anthropic from "@anthropic-ai/sdk";
import {
  SYSTEM_CORE,
  buildBrandContext,
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

const DEFAULT_MODEL = "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — required when AI_PROVIDER=anthropic",
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  // Strip ```json fences just in case the model ignored "no markdown".
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/, "")
    .replace(/```\s*$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Anthropic response did not contain a JSON object");
  }
  return unfenced.slice(start, end + 1);
}

export const anthropicProvider: AiProvider = {
  name: "anthropic",

  async suggest(input: SuggestInput): Promise<SuggestResult> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const userPrompt = buildUserPrompt(input.prompt, input.current);

    // Structure the system prompt as cache-controlled blocks so the stable
    // context is reused across requests instead of re-billed every call.
    // Breakpoint 1 (SYSTEM_CORE): brand-independent → shareable across ALL
    // users within the cache TTL. Breakpoint 2 (brand context): stable for a
    // given brand → a user iterating on suggestions reuses the whole system
    // prefix; only the user brief (the message below) varies. Anthropic caches
    // the longest matching prefix, so both layers earn hits independently.
    const system: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: SYSTEM_CORE,
        cache_control: { type: "ephemeral" },
      },
    ];
    const brandContext = buildBrandContext(input.brand);
    if (brandContext) {
      system.push({
        type: "text",
        text: brandContext,
        cache_control: { type: "ephemeral" },
      });
    }

    const response = await getClient().messages.create({
      model,
      max_tokens: input.maxTokens ?? 400,
      system,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Anthropic returned no text content");
    }

    const parsedJson: unknown = JSON.parse(extractJsonObject(text));
    const output = SuggestOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // Surfaced so the caller can log cache effectiveness. `cache_read > 0`
        // means the stable prefix was served from cache (~10% of input cost);
        // `cache_creation > 0` is the one-time write that seeds it.
        cacheCreationInputTokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  },

  async chat(input: ChatInput): Promise<ChatResult> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const response = await getClient().messages.create({
      model,
      max_tokens: input.maxTokens ?? 300,
      system: [
        {
          type: "text",
          text: buildAvatarSystem(input.brand),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const reply = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!reply) throw new Error("Anthropic returned no text content");

    return {
      reply,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  },

  async extractBrand(input: ExtractBrandInput): Promise<ExtractBrandResult> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

    const userContent: Anthropic.ContentBlockParam[] = [
      { type: "text", text: buildBrandExtractUserText(input.signals) },
    ];
    if (input.screenshot) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: input.screenshot.mediaType,
          data: input.screenshot.base64,
        },
      });
    }

    const response = await getClient().messages.create({
      model,
      max_tokens: input.maxTokens ?? 300,
      system: [
        {
          type: "text",
          text: BRAND_EXTRACT_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Anthropic returned no text content");
    }

    const parsedJson: unknown = JSON.parse(extractJsonObject(text));
    const output = ExtractBrandOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  },

  async generateVideoIdeas(
    input: GenerateVideoIdeasInput,
  ): Promise<GenerateVideoIdeasResult> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

    const response = await getClient().messages.create({
      model,
      max_tokens: input.maxTokens ?? 1200,
      system: [
        {
          type: "text",
          text: VIDEO_IDEAS_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildVideoIdeasUserText(input) }],
    });

    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Anthropic returned no text content");
    }

    const parsedJson: unknown = JSON.parse(extractJsonObject(text));
    const output = GenerateVideoIdeasOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  },

  async pickSections(input: PickSectionsInput): Promise<PickSectionsResult> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

    const response = await getClient().messages.create({
      model,
      max_tokens: input.maxTokens ?? 700,
      system: [
        {
          type: "text",
          text: PICK_SECTIONS_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildPickSectionsUserText(input) }],
    });

    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Anthropic returned no text content");
    }

    const parsedJson: unknown = JSON.parse(extractJsonObject(text));
    const output = PickSectionsOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  },

  async refineWebsiteVideo(
    input: RefineWebsiteVideoInput,
  ): Promise<RefineWebsiteVideoResult> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

    const response = await getClient().messages.create({
      model,
      max_tokens: input.maxTokens ?? 400,
      system: [
        {
          type: "text",
          text: REFINE_VIDEO_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildRefineVideoUserText(input) }],
    });

    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Anthropic returned no text content");
    }

    const parsedJson: unknown = JSON.parse(extractJsonObject(text));
    const output = RefineWebsiteVideoOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  },

  async judgeTours(input: JudgeToursInput): Promise<JudgeToursResult> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

    const userContent: Anthropic.ContentBlockParam[] = [
      { type: "text", text: buildJudgeToursUserText(input) },
    ];
    if (input.screenshot) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: input.screenshot.mediaType,
          data: input.screenshot.base64,
        },
      });
    }

    const response = await getClient().messages.create({
      model,
      max_tokens: input.maxTokens ?? 200,
      system: [
        {
          type: "text",
          text: JUDGE_TOURS_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
    });

    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Anthropic returned no text content");
    }

    const parsedJson: unknown = JSON.parse(extractJsonObject(text));
    const output = JudgeToursOutputSchema.parse(parsedJson);

    return {
      ...output,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  },
};
