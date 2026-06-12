import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalMediaEnabled } from "../lib/localMediaEnabled";

/**
 * The local-media gate truth table + the fallback wiring. These NEVER load the
 * real ONNX models — the model packages are mocked, so the tests are fast and
 * hermetic. The gate's double condition (flag AND non-production) is the safety
 * rail that keeps the dev fallback out of prod.
 */

const ENV = ["LOCAL_MEDIA_MODELS", "NODE_ENV", "OPENAI_API_KEY", "TTS_API_KEY", "WHISPER_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("isLocalMediaEnabled", () => {
  it("is true only with the flag set AND a non-production env", () => {
    expect(isLocalMediaEnabled()).toBe(false); // flag unset

    process.env.LOCAL_MEDIA_MODELS = "true";
    delete process.env.NODE_ENV;
    expect(isLocalMediaEnabled()).toBe(true);

    process.env.NODE_ENV = "development";
    expect(isLocalMediaEnabled()).toBe(true);

    // Production overrides the flag — the dev fallback never ships.
    process.env.NODE_ENV = "production";
    expect(isLocalMediaEnabled()).toBe(false);

    // A non-"true" value is off.
    process.env.NODE_ENV = "development";
    process.env.LOCAL_MEDIA_MODELS = "1";
    expect(isLocalMediaEnabled()).toBe(false);
  });
});

describe("ttsService.synthesizeSpeech — local fallback", () => {
  it("routes to the local model when no key is set and the flag is on", async () => {
    vi.doMock("./localMediaService", () => ({
      synthesizeSpeechLocal: vi.fn(async () => Buffer.from("local-mp3")),
      transcribeBufferLocal: vi.fn(),
    }));
    process.env.LOCAL_MEDIA_MODELS = "true";
    process.env.NODE_ENV = "development";

    const { synthesizeSpeech } = await import("./ttsService");
    const out = await synthesizeSpeech({ input: "hi", voice: "alloy" });
    expect(out.toString()).toBe("local-mp3");
  });

  it("throws TtsNotConfiguredError when no key AND the flag is off (503 pin)", async () => {
    const { synthesizeSpeech, TtsNotConfiguredError } = await import(
      "./ttsService"
    );
    await expect(
      synthesizeSpeech({ input: "hi", voice: "alloy" }),
    ).rejects.toBeInstanceOf(TtsNotConfiguredError);
  });
});

describe("transcriptionService.transcribeBuffer — local fallback", () => {
  it("routes to the local model when no key is set and the flag is on", async () => {
    vi.doMock("./localMediaService", () => ({
      synthesizeSpeechLocal: vi.fn(),
      transcribeBufferLocal: vi.fn(async () => ({
        words: [{ text: "hi", start: 0, end: 1 }],
        duration: 1,
      })),
    }));
    process.env.LOCAL_MEDIA_MODELS = "true";
    process.env.NODE_ENV = "development";

    const { transcribeBuffer } = await import("./transcriptionService");
    const out = await transcribeBuffer(Buffer.from("audio"), "audio/mp3");
    expect(out.words).toHaveLength(1);
    expect(out.duration).toBe(1);
  });

  it("throws TranscriptionNotConfiguredError when no key AND flag off (503 pin)", async () => {
    const { transcribeBuffer, TranscriptionNotConfiguredError } = await import(
      "./transcriptionService"
    );
    await expect(
      transcribeBuffer(Buffer.from("audio"), "audio/mp3"),
    ).rejects.toBeInstanceOf(TranscriptionNotConfiguredError);
  });
});
