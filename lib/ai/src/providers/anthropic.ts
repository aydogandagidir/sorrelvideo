import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, buildUserPrompt } from "../prompt";
import {
  SuggestOutputSchema,
  type SuggestInput,
  type SuggestResult,
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
    const system = buildSystemPrompt(input.brand);
    const userPrompt = buildUserPrompt(input.prompt);

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
      },
    };
  },
};
