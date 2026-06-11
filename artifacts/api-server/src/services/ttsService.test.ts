import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TTS_VOICE,
  isTtsConfigured,
  synthesizeSpeech,
  TTS_VOICES,
  TtsError,
  TtsNotConfiguredError,
} from "./ttsService";

const KEYS = ["TTS_API_KEY", "OPENAI_API_KEY", "OPENAI_TTS_MODEL"] as const;

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function stubTts(ok = true) {
  const bytes = Uint8Array.from([1, 2, 3, 4]).buffer;
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    arrayBuffer: async () => bytes,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("isTtsConfigured", () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => restoreEnv(saved));

  it("is false when neither key is set", () => {
    for (const k of KEYS) delete process.env[k];
    expect(isTtsConfigured()).toBe(false);
  });

  it("is true with TTS_API_KEY and falls back to OPENAI_API_KEY", () => {
    for (const k of KEYS) delete process.env[k];
    process.env.TTS_API_KEY = "sk-tts";
    expect(isTtsConfigured()).toBe(true);
    delete process.env.TTS_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(isTtsConfigured()).toBe(true);
  });
});

describe("synthesizeSpeech", () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    restoreEnv(saved);
    vi.unstubAllGlobals();
  });

  it("exposes the default voice within the catalog", () => {
    expect(TTS_VOICES).toContain(DEFAULT_TTS_VOICE);
  });

  it("throws TtsNotConfiguredError when no key is set", async () => {
    for (const k of KEYS) delete process.env[k];
    await expect(
      synthesizeSpeech({ input: "hi", voice: "alloy" }),
    ).rejects.toBeInstanceOf(TtsNotConfiguredError);
  });

  it("posts the default model with voice/input/mp3 and returns the bytes", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = "sk-openai";
    const fetchMock = stubTts();
    const buf = await synthesizeSpeech({ input: "Hello there", voice: "nova" });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf]).toEqual([1, 2, 3, 4]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.model).toBe("gpt-4o-mini-tts");
    expect(body.voice).toBe("nova");
    expect(body.input).toBe("Hello there");
    expect(body.response_format).toBe("mp3");
  });

  it("prefers TTS_API_KEY over OPENAI_API_KEY", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.TTS_API_KEY = "sk-tts";
    process.env.OPENAI_API_KEY = "sk-openai";
    const fetchMock = stubTts();
    await synthesizeSpeech({ input: "hi", voice: "alloy" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-tts",
    );
  });

  it("includes instructions only on the gpt-4o-mini-tts family", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = "sk-openai";
    let fetchMock = stubTts();
    await synthesizeSpeech({
      input: "hi",
      voice: "alloy",
      instructions: "Speak warmly",
    });
    let body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    ) as Record<string, string>;
    expect(body.instructions).toBe("Speak warmly");

    // The tts-1 family rejects the param — an env override must drop it.
    process.env.OPENAI_TTS_MODEL = "tts-1";
    fetchMock = stubTts();
    await synthesizeSpeech({
      input: "hi",
      voice: "alloy",
      instructions: "Speak warmly",
    });
    body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    ) as Record<string, string>;
    expect(body.model).toBe("tts-1");
    expect(body.instructions).toBeUndefined();
  });

  it("maps a provider error to TtsError(502)", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = "sk-openai";
    stubTts(false);
    const err = await synthesizeSpeech({ input: "hi", voice: "alloy" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TtsError);
    expect((err as TtsError).status).toBe(502);
  });

  it("maps a network throw to TtsError(502)", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = "sk-openai";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(
      synthesizeSpeech({ input: "hi", voice: "alloy" }),
    ).rejects.toBeInstanceOf(TtsError);
  });
});
