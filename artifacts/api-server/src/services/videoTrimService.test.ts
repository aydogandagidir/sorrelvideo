import { describe, expect, it } from "vitest";
import {
  buildAssSubtitles,
  encodeSmartTrimPayload,
  decodeSmartTrimPayload,
  type CaptionWord,
} from "./videoTrimService";

const WORDS: CaptionWord[] = [
  { text: "the", start: 0.0, end: 0.3 },
  { text: "quick", start: 0.3, end: 0.6 },
  { text: "brown", start: 0.6, end: 0.9 },
  { text: "fox", start: 0.9, end: 1.2 },
];

describe("buildAssSubtitles", () => {
  it("emits valid ASS scaffolding (Script Info / Styles / Events)", () => {
    const ass = buildAssSubtitles(WORDS);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("Style: Sorrel,");
  });

  it("groups words into 2-word UPPERCASE chunks by default", () => {
    const ass = buildAssSubtitles(WORDS);
    expect(ass).toContain(
      "Dialogue: 0,0:00:00.00,0:00:00.60,Sorrel,,0,0,0,,THE QUICK",
    );
    expect(ass).toContain(
      "Dialogue: 0,0:00:00.60,0:00:01.20,Sorrel,,0,0,0,,BROWN FOX",
    );
    // Exactly two caption lines for four words.
    expect(ass.match(/^Dialogue:/gm)?.length).toBe(2);
  });

  it("honors a custom wordsPerChunk", () => {
    const ass = buildAssSubtitles(WORDS, { wordsPerChunk: 1 });
    expect(ass.match(/^Dialogue:/gm)?.length).toBe(4);
    expect(ass).toContain(",FOX");
  });

  it("uses the brand accent (#RRGGBB → ASS &H00BBGGRR) as the outline colour", () => {
    const ass = buildAssSubtitles(WORDS, { accentColor: "#a3e635" });
    // a3/e6/35 → &H00 + 35 + E6 + A3.
    expect(ass).toContain("&H0035E6A3");
  });

  it("falls back to white outline for a malformed colour", () => {
    const ass = buildAssSubtitles(WORDS, { accentColor: "not-a-color" });
    // Outline colour slot is white when the hex doesn't parse.
    expect(ass).toContain(",&H00FFFFFF,&H64000000,");
  });

  it("strips ASS-significant characters from user text", () => {
    const ass = buildAssSubtitles([{ text: "{drop}", start: 0, end: 0.5 }]);
    expect(ass).toContain(",DROP");
    expect(ass).not.toContain("{drop}");
  });

  it("produces no Dialogue lines for an empty word list", () => {
    const ass = buildAssSubtitles([]);
    expect(ass).not.toContain("Dialogue:");
    // Header is still well-formed.
    expect(ass).toContain("[Events]");
  });

  it("drops malformed words (end ≤ start, non-finite)", () => {
    const ass = buildAssSubtitles([
      { text: "ok", start: 0, end: 0.5 },
      { text: "bad", start: 1, end: 1 },
      { text: "nan", start: Number.NaN, end: 2 },
    ]);
    expect(ass.match(/^Dialogue:/gm)?.length).toBe(1);
    expect(ass).toContain(",OK");
  });
});

describe("smart trim payload codec", () => {
  const payload = {
    source: "/objects/uploads/abc-123",
    segments: [
      { start: 0, end: 1.08 },
      { start: 3.3, end: 4.88 },
    ],
  };

  it("round-trips encode → decode", () => {
    const decoded = decodeSmartTrimPayload(encodeSmartTrimPayload(payload));
    expect(decoded).toEqual(payload);
  });

  it("rejects a non-objects source path", () => {
    const b64 = encodeSmartTrimPayload({
      source: "https://evil.example/x",
      segments: [{ start: 0, end: 1 }],
    });
    expect(decodeSmartTrimPayload(b64)).toBeNull();
  });

  it("rejects garbage / non-base64", () => {
    expect(decodeSmartTrimPayload("not base64 @@@")).toBeNull();
    expect(decodeSmartTrimPayload("")).toBeNull();
  });

  it("drops malformed segments and returns null when none survive", () => {
    const b64 = encodeSmartTrimPayload({
      source: "/objects/uploads/x",
      segments: [{ start: 2, end: 1 }],
    });
    expect(decodeSmartTrimPayload(b64)).toBeNull();
  });

  it("keeps only the well-formed segments", () => {
    const raw = Buffer.from(
      JSON.stringify({
        source: "/objects/uploads/x",
        segments: [
          { start: 0, end: 1 },
          { start: 5, end: 4 }, // dropped (end ≤ start)
          { start: 2, end: 3 },
        ],
      }),
      "utf-8",
    ).toString("base64");
    expect(decodeSmartTrimPayload(raw)).toEqual({
      source: "/objects/uploads/x",
      segments: [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
    });
  });
});
