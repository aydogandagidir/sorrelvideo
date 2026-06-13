/**
 * DEV-ONLY local media models — a zero-API-key fallback for TTS + transcription.
 *
 * When `LOCAL_MEDIA_MODELS=true` (and NOT production), the talking-host + caption
 * flows fall back to local ONNX models instead of OpenAI: Kokoro-82M for speech
 * (`kokoro-js`) and Whisper base.en for word-timed transcription
 * (`@huggingface/transformers`). Both run fully in Node via onnxruntime-node —
 * no Python, no external binaries. An OpenAI key, when present, ALWAYS wins;
 * this is strictly a fallback.
 *
 * The model packages are devDependencies, loaded ONLY through the lazy
 * `await import(...)` calls below — so the production bundle builds + boots
 * without them, and the ~250MB of model weights download to the HF cache only on
 * first use under the flag. Both gates (the flag AND non-production) must pass.
 */
import { spawn } from "node:child_process";
import { logger } from "../lib/logger";
import { TtsError, type TtsVoice } from "./ttsService";
import {
  TranscriptionError,
  type TranscriptionResult,
  type TranscriptWord,
} from "./transcriptionService";

export { isLocalMediaEnabled } from "../lib/localMediaEnabled";

const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const WHISPER_MODEL = "onnx-community/whisper-base.en";

/** Map an OpenAI voice name to a Kokoro voice id (rough tonal match). */
const VOICE_MAP: Record<string, string> = {
  alloy: "af_heart",
  ash: "am_adam",
  ballad: "af_bella",
  coral: "af_nicole",
  echo: "am_michael",
  fable: "bf_emma",
  nova: "af_sky",
  onyx: "am_adam",
  sage: "af_sarah",
  shimmer: "af_sky",
};

// Singletons — the model load (+ first-run weight download) is expensive, so a
// process keeps one instance alive across calls.
let kokoroPromise: Promise<unknown> | null = null;
let whisperPromise: Promise<unknown> | null = null;

/* eslint-disable @typescript-eslint/no-explicit-any -- the lazy-imported model
   packages are devDeps with broad runtime types; narrow at the call boundary. */
async function getKokoro(): Promise<any> {
  if (!kokoroPromise) {
    logger.info("Loading local Kokoro TTS model (first run downloads ~90MB)…");
    kokoroPromise = import("kokoro-js").then((m) =>
      m.KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8" }),
    );
  }
  return kokoroPromise;
}

async function getWhisper(): Promise<any> {
  if (!whisperPromise) {
    logger.info(
      "Loading local Whisper model (first run downloads ~150MB)…",
    );
    whisperPromise = import("@huggingface/transformers").then((m) =>
      m.pipeline("automatic-speech-recognition", WHISPER_MODEL),
    );
  }
  return whisperPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Pipe a buffer through ffmpeg, collecting stdout. Rejects on a non-zero exit. */
function ffmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`)),
    );
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * Synthesize speech locally → MP3 Buffer. Kokoro emits WAV; we transcode to MP3
 * with ffmpeg (already required by the render pipeline) so the talking-host
 * `voice.mp3` contract holds. `instructions` (brand tone) is ignored — Kokoro has
 * no equivalent knob.
 */
export async function synthesizeSpeechLocal(opts: {
  input: string;
  voice: TtsVoice;
}): Promise<Buffer> {
  try {
    const tts = await getKokoro();
    const voice = VOICE_MAP[opts.voice] ?? "af_heart";
    const audio = await tts.generate(opts.input, { voice });
    const wav = Buffer.from(audio.toWav());
    // WAV → MP3 (read from stdin, write to stdout).
    return await ffmpeg(
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "mp3", "pipe:1"],
      wav,
    );
  } catch (err) {
    logger.error({ err }, "Local TTS synthesis failed");
    throw new TtsError("Local speech synthesis failed");
  }
}

/**
 * Transcribe an audio buffer locally → word-timed `TranscriptionResult`. Decodes
 * the input to 16kHz mono float32 (Whisper's expected input) with ffmpeg, runs
 * the local Whisper pipeline with word timestamps, and maps the chunks to the
 * same `{text,start,end}` shape + duration the OpenAI path returns.
 */
export async function transcribeBufferLocal(
  buf: Buffer | Uint8Array,
): Promise<TranscriptionResult> {
  try {
    // Decode to raw 16kHz mono float32 little-endian.
    const raw = await ffmpeg(
      [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-f", "f32le", "-ac", "1", "-ar", "16000",
        "pipe:1",
      ],
      Buffer.from(buf),
    );
    const samples = new Float32Array(
      raw.buffer,
      raw.byteOffset,
      Math.floor(raw.byteLength / 4),
    );

    const transcriber = await getWhisper();
    const result = await transcriber(samples, {
      return_timestamps: "word",
      chunk_length_s: 30,
    });

    const rawChunks: Array<{ text?: unknown; timestamp?: unknown }> =
      Array.isArray(result?.chunks) ? result.chunks : [];
    const words: TranscriptWord[] = [];
    for (const c of rawChunks) {
      const text = typeof c.text === "string" ? c.text.trim() : "";
      const ts = Array.isArray(c.timestamp) ? c.timestamp : [];
      const start = typeof ts[0] === "number" ? ts[0] : null;
      const end = typeof ts[1] === "number" ? ts[1] : null;
      if (text.length > 0 && start !== null && end !== null && end > start) {
        words.push({ text, start, end });
      }
    }

    const duration = samples.length / 16000;
    return { words, duration: Number.isFinite(duration) ? duration : null };
  } catch (err) {
    logger.error({ err }, "Local transcription failed");
    throw new TranscriptionError("Local transcription failed");
  }
}
