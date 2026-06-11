/**
 * Text-to-speech service (talking-host narration) — turns a user script into
 * MP3 bytes via OpenAI's speech API. The structural twin of
 * transcriptionService: fetch-based (no SDK), config-gated errors with an HTTP
 * `status`, and deliberately NOT a `@workspace/ai` provider method (Anthropic
 * has no TTS; this is a distinct audio endpoint, exactly like Whisper).
 *
 * CONFIG-GATED: needs `TTS_API_KEY` (preferred) or `OPENAI_API_KEY` (the
 * WHISPER_API_KEY pattern). When neither is set the endpoint 503s and the UI
 * surfaces "not configured" — the rest of the app keeps working.
 *
 * Model: `OPENAI_TTS_MODEL` env override, default `gpt-4o-mini-tts`. The
 * `instructions` param (brand tone steering) is only valid on the
 * gpt-4o-mini-tts family — it is dropped for `tts-1`-style overrides so an env
 * change can't break the request.
 */
import { logger } from "../lib/logger";

/** The OpenAI speech-voice catalog (gpt-4o-mini-tts / tts-1 family). */
export const TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const DEFAULT_TTS_VOICE: TtsVoice = "alloy";

const TTS_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";

/** No TTS key configured → the route maps this to 503. */
export class TtsNotConfiguredError extends Error {
  readonly status = 503 as const;
  constructor() {
    super("Text-to-speech is not configured");
    this.name = "TtsNotConfiguredError";
  }
}

/** Any other synthesis failure; `status` is the HTTP code the route returns. */
export class TtsError extends Error {
  constructor(
    message: string,
    readonly status: 502 = 502,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

/** Whether a TTS key is configured (used to hide the UI affordance). */
export function isTtsConfigured(): boolean {
  return Boolean(process.env.TTS_API_KEY ?? process.env.OPENAI_API_KEY);
}

/**
 * Synthesize a script into MP3 bytes. `instructions` steers delivery tone
 * (derived from the brand kit's voice/personality) and is only sent when the
 * resolved model supports it.
 */
export async function synthesizeSpeech(opts: {
  input: string;
  voice: TtsVoice;
  instructions?: string;
}): Promise<Buffer> {
  const apiKey = process.env.TTS_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new TtsNotConfiguredError();

  const model = process.env.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL;
  const body: Record<string, string> = {
    model,
    voice: opts.voice,
    input: opts.input,
    response_format: "mp3",
  };
  if (opts.instructions && model.startsWith("gpt-4o-mini-tts")) {
    body.instructions = opts.instructions;
  }

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.error({ err }, "TTS request threw");
    throw new TtsError("Speech synthesis unavailable");
  }
  if (!res.ok) {
    logger.error({ status: res.status, model }, "TTS API returned an error");
    throw new TtsError("Speech synthesis failed");
  }
  return Buffer.from(await res.arrayBuffer());
}
