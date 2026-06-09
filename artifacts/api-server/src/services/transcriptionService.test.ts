import { afterEach, describe, expect, it } from "vitest";
import { isTranscriptionConfigured } from "./transcriptionService";

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
