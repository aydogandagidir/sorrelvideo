import { describe, expect, it } from "vitest";
import {
  buildHostPayload,
  buildVoiceInstructions,
  computeHostDuration,
  HOST_INTRO_SECONDS,
  HOST_OUTRO_SECONDS,
  hostProjectName,
} from "./talkingHostService";
import type { TranscriptWord } from "./transcriptionService";

const WORDS: TranscriptWord[] = [
  { text: "Hello", start: 0.001, end: 0.456 },
  { text: "world", start: 0.5, end: 1.119 },
];

describe("buildHostPayload", () => {
  it("round-trips through base64 with 2-decimal timing precision", () => {
    const payload = buildHostPayload(WORDS, 0.9, 1.4);
    // Base64 alphabet only — survives escapeMarkup byte-identical.
    expect(payload).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const decoded = JSON.parse(
      Buffer.from(payload, "base64").toString("utf-8"),
    ) as { intro: number; outro: number; words: [string, number, number][] };
    expect(decoded.intro).toBe(0.9);
    expect(decoded.outro).toBe(1.4);
    expect(decoded.words).toEqual([
      ["Hello", 0, 0.46],
      ["world", 0.5, 1.12],
    ]);
  });

  it("encodes user text (quotes, unicode) without corruption", () => {
    const tricky: TranscriptWord[] = [
      { text: `say "hi" <b>&amp;</b> 'çok' 🎬`, start: 0, end: 1 },
    ];
    const decoded = JSON.parse(
      Buffer.from(buildHostPayload(tricky, 0.9, 1.4), "base64").toString("utf-8"),
    ) as { words: [string, number, number][] };
    expect(decoded.words[0][0]).toBe(`say "hi" <b>&amp;</b> 'çok' 🎬`);
  });
});

describe("computeHostDuration", () => {
  it("prefers the Whisper clip duration", () => {
    expect(computeHostDuration(WORDS, 6.62)).toBe(
      Math.round((HOST_INTRO_SECONDS + 6.62 + HOST_OUTRO_SECONDS) * 10) / 10,
    );
  });

  it("falls back to the last word's end", () => {
    expect(computeHostDuration(WORDS, null)).toBe(
      Math.round((HOST_INTRO_SECONDS + 1.119 + HOST_OUTRO_SECONDS) * 10) / 10,
    );
  });

  it("clamps to the 3–120s window", () => {
    expect(computeHostDuration([], null)).toBeGreaterThanOrEqual(3);
    expect(computeHostDuration(WORDS, 1000)).toBe(120);
  });
});

describe("hostProjectName", () => {
  it("keeps short scripts verbatim (whitespace collapsed)", () => {
    expect(hostProjectName("  Hello   brand\nworld  ")).toBe("Hello brand world");
  });

  it("trims long scripts at a word boundary with an ellipsis", () => {
    const name = hostProjectName(
      "This is a fairly long opening sentence that keeps going well past the cap",
    );
    expect(name.length).toBeLessThanOrEqual(49);
    expect(name.endsWith("…")).toBe(true);
    expect(name).not.toContain("  ");
  });
});

describe("buildVoiceInstructions", () => {
  it("returns undefined without a kit or any voice signal", () => {
    expect(buildVoiceInstructions(null)).toBeUndefined();
    expect(
      buildVoiceInstructions({
        brandVoice: null,
        personality: null,
        voiceDescription: null,
      }),
    ).toBeUndefined();
  });

  it("composes tone + personality + description, bounded", () => {
    const out = buildVoiceInstructions({
      brandVoice: "playful",
      personality: ["warm", "witty", "", "curious", "extra", "more"],
      voiceDescription: "  Always end upbeat.  ",
    });
    expect(out).toContain("upbeat, playful and friendly");
    expect(out).toContain("warm, witty, curious, extra");
    expect(out).not.toContain("more");
    expect(out).toContain("Always end upbeat.");
    expect((out ?? "").length).toBeLessThanOrEqual(400);
  });
});
