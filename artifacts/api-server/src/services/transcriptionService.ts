/**
 * Transcription service (Track E2) — turns an uploaded audio object into
 * word-timed captions via OpenAI's Whisper API (`whisper-1`, verbose_json with
 * word-level timestamps). Feeds RenderSettings.captions, which the render path
 * (renderService.buildCaptionOverlay) burns in as a root-timeline overlay.
 *
 * CONFIG-GATED: needs `WHISPER_API_KEY` (preferred) or `OPENAI_API_KEY`. When
 * neither is set the endpoint 503s and the UI hides the "Auto-caption" action —
 * the rest of the app (and captions set manually via the API) still work.
 *
 * NOT a `@workspace/ai` chat-provider method on purpose: Anthropic/OpenAI chat
 * models don't do ASR; this is a distinct multipart upload to the audio endpoint.
 */
import { ObjectStorageService } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";
import { logger } from "../lib/logger";

export interface TranscriptWord {
  text: string;
  /** Seconds from the start of the audio. */
  start: number;
  /** Seconds from the start of the audio. */
  end: number;
}

/** No ASR key configured → the route maps this to 503. */
export class TranscriptionNotConfiguredError extends Error {
  readonly status = 503 as const;
  constructor() {
    super("Transcription is not configured");
    this.name = "TranscriptionNotConfiguredError";
  }
}

/** Any other transcription failure; `status` is the HTTP code the route returns. */
export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 413 | 502 = 502,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
/** OpenAI's hard upload cap for the audio endpoint. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Whether an ASR key is configured (used to hide the UI affordance). */
export function isTranscriptionConfigured(): boolean {
  return Boolean(process.env.WHISPER_API_KEY ?? process.env.OPENAI_API_KEY);
}

/**
 * Transcribe a user-uploaded audio object ("/objects/...") into word-timed
 * captions. Re-checks ownership (defense in depth) before touching the file.
 */
export async function transcribeObject(
  userId: string,
  objectPath: string,
): Promise<TranscriptWord[]> {
  const apiKey = process.env.WHISPER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new TranscriptionNotConfiguredError();

  const storage = new ObjectStorageService();
  let file: Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;
  try {
    file = await storage.getObjectEntityFile(objectPath);
  } catch {
    throw new TranscriptionError("Audio object not found", 404);
  }
  const canRead = await storage.canAccessObjectEntity({
    userId,
    objectFile: file,
    requestedPermission: ObjectPermission.READ,
  });
  if (!canRead) throw new TranscriptionError("Audio object not found", 404);

  const [meta] = await file.getMetadata();
  const size = Number(meta.size ?? 0);
  if (size > MAX_AUDIO_BYTES) {
    throw new TranscriptionError(
      "Audio exceeds the 25MB transcription limit",
      413,
    );
  }
  const contentType = (meta.contentType as string) || "audio/mpeg";
  const [buf] = await file.download();

  const form = new FormData();
  // Wrap in a fresh Uint8Array — a Node Buffer<ArrayBufferLike> isn't a valid
  // DOM BlobPart (its backing buffer is ArrayBufferLike, not ArrayBuffer).
  form.append("file", new Blob([new Uint8Array(buf)], { type: contentType }), "audio");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    logger.error({ err }, "Whisper request threw");
    throw new TranscriptionError("Transcription service unavailable", 502);
  }
  if (!res.ok) {
    logger.error({ status: res.status }, "Whisper API returned an error");
    throw new TranscriptionError("Transcription failed", 502);
  }

  const data = (await res.json()) as {
    words?: { word?: string; start?: number; end?: number }[];
  };
  return (data.words ?? [])
    .map((w) => ({
      text: String(w.word ?? "").trim(),
      start: Number(w.start),
      end: Number(w.end),
    }))
    .filter(
      (w) =>
        w.text.length > 0 &&
        Number.isFinite(w.start) &&
        Number.isFinite(w.end) &&
        w.end > w.start,
    );
}
