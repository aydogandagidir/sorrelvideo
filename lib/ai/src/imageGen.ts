import OpenAI from "openai";
import { buildImagePrompt } from "./prompt";
import {
  GenerateImageInputSchema,
  type GenerateImageInput,
  type GenerateImageResult,
  type ImageAspect,
} from "./schema";

/**
 * AI BACKGROUND image generation. This is GENERATIVE MEDIA, deliberately kept
 * OFF the `AiProvider` interface: Anthropic has no image-generation API, so this
 * always routes to OpenAI Images (`gpt-image-1`) regardless of `AI_PROVIDER`
 * (which only picks the TEXT provider). The result is an inline data URI ready
 * to drop into a composition's `compositionVars` (the same channel website→video
 * uses for `capture.image`), so the render/preview pipeline needs no new asset
 * plumbing.
 *
 * Key resolution mirrors the talking-host TTS path (`TTS_API_KEY ??
 * OPENAI_API_KEY`): `IMAGE_API_KEY ?? OPENAI_API_KEY`. With neither set, the
 * route surfaces a 503 "not configured" (same shape as /ai/suggest), so the
 * feature degrades cleanly instead of crashing.
 */
const DEFAULT_IMAGE_MODEL = "gpt-image-1";

/** gpt-image-1 quality tiers (cost ↔ fidelity). Default `medium`. */
type ImageQuality = "low" | "medium" | "high" | "auto";
/** gpt-image-1 output encodings. Default `jpeg` to bound the persisted blob. */
type ImageFormat = "png" | "jpeg" | "webp";

/**
 * Map each frame aspect to a gpt-image-1 size. The model only offers these three
 * shapes (plus `auto`); the composition scales the image to cover regardless, so
 * matching the closest aspect just minimises cropping.
 */
const SIZE_BY_ASPECT: Record<ImageAspect, "1024x1024" | "1536x1024" | "1024x1536"> = {
  portrait: "1024x1536",
  landscape: "1536x1024",
  square: "1024x1024",
};

const MEDIA_TYPE: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

let client: OpenAI | null = null;
function getImageClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.IMAGE_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "IMAGE_API_KEY (or OPENAI_API_KEY) is not set — required for AI image generation",
      );
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

function resolveQuality(): ImageQuality {
  const q = process.env.OPENAI_IMAGE_QUALITY;
  return q === "low" || q === "high" || q === "auto" ? q : "medium";
}

function resolveFormat(): ImageFormat {
  const f = process.env.OPENAI_IMAGE_FORMAT;
  return f === "png" || f === "webp" ? f : "jpeg";
}

/**
 * Generate an on-brand background image and return it as an inline data URI.
 * Throws on missing key (config error → caller 503s) or a provider error
 * (caller 502s) — never burns quota itself (the route charges AFTER success).
 */
export async function generateBrandImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const parsed = GenerateImageInputSchema.parse(input);
  const model = process.env.OPENAI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
  const format = resolveFormat();
  const quality = resolveQuality();

  const response = await getImageClient().images.generate({
    model,
    prompt: buildImagePrompt(parsed.prompt, parsed.brand, parsed.aspect),
    size: SIZE_BY_ASPECT[parsed.aspect],
    quality,
    // gpt-image-1 always returns base64 (no `url` option) and accepts an output
    // encoding; jpeg/webp keep the persisted data URI ~0.3–1MB vs PNG's several.
    output_format: format,
    n: 1,
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Image provider returned no image data");
  }

  return {
    dataUri: `data:${MEDIA_TYPE[format]};base64,${b64}`,
    model,
    // base64 expands ~4/3; the decoded size is the real persisted-blob cost.
    bytes: Math.floor((b64.length * 3) / 4),
  };
}
