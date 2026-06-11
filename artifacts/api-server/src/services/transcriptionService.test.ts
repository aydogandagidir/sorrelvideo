import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTranscriptionConfigured,
  transcribeBuffer,
  TranscriptionError,
  TranscriptionNotConfiguredError,
} from "./transcriptionService";

const KEYS = ["WHISPER_API_KEY", "OPENAI_API_KEY"] as const;

describe("isTranscriptionConfigured", () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is false when neither key is set", () => {
    for (const k of KEYS) delete process.env[k];
    expect(isTranscriptionConfigured()).toBe(false);
  });

  it("is true when WHISPER_API_KEY is set", () => {
    for (const k of KEYS) delete process.env[k];
    process.env.WHISPER_API_KEY = "sk-whisper-test";
    expect(isTranscriptionConfigured()).toBe(true);
  });

  it("falls back to OPENAI_API_KEY", () => {
    for (const k of KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = "sk-openai-test";
    expect(isTranscriptionConfigured()).toBe(true);
  });
});

describe("transcribeBuffer", () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  function stubWhisper(payload: unknown, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("throws TranscriptionNotConfiguredError when no key is set", async () => {
    for (const k of KEYS) delete process.env[k];
    await expect(
      transcribeBuffer(Buffer.from("x"), "audio/mpeg"),
    ).rejects.toBeInstanceOf(TranscriptionNotConfiguredError);
  });

  it("maps + filters words and surfaces the verbose_json duration", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubWhisper({
      duration: 6.62,
      words: [
        { word: " Hello ", start: 0, end: 0.4 },
        { word: "", start: 0.4, end: 0.6 }, // empty → dropped
        { word: "bad", start: 1, end: 1 }, // end <= start → dropped
        { word: "world", start: 0.5, end: 1.1 },
      ],
    });
    const out = await transcribeBuffer(Buffer.from("mp3"), "audio/mpeg");
    expect(out.words).toEqual([
      { text: "Hello", start: 0, end: 0.4 },
      { text: "world", start: 0.5, end: 1.1 },
    ]);
    expect(out.duration).toBe(6.62);
  });

  it("returns duration null when verbose_json omits it", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubWhisper({ words: [{ word: "hi", start: 0, end: 0.3 }] });
    const out = await transcribeBuffer(Buffer.from("mp3"), "audio/mpeg");
    expect(out.duration).toBeNull();
    expect(out.words).toHaveLength(1);
  });

  it("sends the word-granularity verbose_json multipart request", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = stubWhisper({ words: [] });
    await transcribeBuffer(Buffer.from("mp3"), "audio/mpeg");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("timestamp_granularities[]")).toBe("word");
  });

  it("maps a provider error to TranscriptionError(502)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubWhisper({}, false);
    const err = await transcribeBuffer(Buffer.from("mp3"), "audio/mpeg").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as TranscriptionError).status).toBe(502);
  });

  it("rejects buffers over the 25MB Whisper cap with 413", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const big = Buffer.alloc(25 * 1024 * 1024 + 1);
    const err = await transcribeBuffer(big, "audio/mpeg").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as TranscriptionError).status).toBe(413);
  });
});
